import hashlib
import json
import math
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from functools import wraps
from pathlib import Path
from datetime import timedelta
from zoneinfo import ZoneInfo

from flask import Flask, g, jsonify, redirect, request, send_from_directory, session, url_for
from flask.sessions import SecureCookieSessionInterface
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash


BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "littletrack.db"
SECRET_KEY_PATH = DATA_DIR / ".flask-secret-key"
# One-time code needed to set the first password (stops anyone else claiming a new server).
SETUP_CODE_PATH = DATA_DIR / "setup-code.txt"
DEFAULT_FEEDING_TIMES = ["02:00", "06:00", "08:30", "11:00", "14:00", "17:00", "19:30", "22:00"]
LOCAL_TZ = ZoneInfo("Australia/Melbourne")
SESSION_DAYS = 90
def env_value(name, default=None):
    """MLKBAR_<name>, falling back to the old LITTLETRACK_<name>."""
    value = os.environ.get(f"MLKBAR_{name}")
    if value is None:
        value = os.environ.get(f"LITTLETRACK_{name}")
    return default if value is None else value


SECURE_COOKIE_MODE = env_value("SECURE_COOKIE", "auto").strip().lower()
LOGIN_MAX_FAILURES = 5
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_LOCKOUT_SECONDS = 5 * 60

# In-memory login throttle. Assumes a single worker process (see Dockerfile).
_login_failures = {}
_login_lock = threading.Lock()

DATA_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=str(PUBLIC_DIR), static_url_path="")
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=SESSION_DAYS)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Strict"
app.config["SESSION_COOKIE_SECURE"] = SECURE_COOKIE_MODE == "true"
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024


class ProxyAwareSessionInterface(SecureCookieSessionInterface):
    def get_cookie_secure(self, app):
        if SECURE_COOKIE_MODE == "auto":
            return request.is_secure
        return SECURE_COOKIE_MODE == "true"


def env_flag(name, default=False):
    value = env_value(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


if env_flag("TRUST_PROXY"):
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

app.session_interface = ProxyAwareSessionInterface()


def load_secret_key():
    configured = env_value("SECRET_KEY", "").strip()
    if configured:
        return configured

    if SECRET_KEY_PATH.exists():
        existing = SECRET_KEY_PATH.read_text(encoding="utf-8").strip()
        if existing:
            return existing

    generated = secrets.token_hex(32)
    SECRET_KEY_PATH.write_text(generated, encoding="utf-8")
    os.chmod(SECRET_KEY_PATH, 0o600)
    return generated


app.secret_key = load_secret_key()


@contextmanager
def get_db():
    """Open a connection, commit on success / roll back on error, and always close."""
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------

# Matches JS Date.prototype.toISOString(), which is what the client sends and
# what every existing row uses. Keeping one format keeps string sorting correct.
ISO_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
MAX_ID_LENGTH = 64
MAX_NOTES_LENGTH = 5000
MAX_FOOD_LENGTH = 80
MAX_MEDICINE_LENGTH = 80
MAX_DOSE_LENGTH = 40
MAX_MILK_ML = 2000
MAX_WEIGHT_GRAMS = 30000
MAX_NAP_MINUTES = 24 * 60
MAX_BREAST_SECONDS = 6 * 60 * 60
BREAST_SIDES = ("left", "right", "both")
TIMER_KINDS = ("breast", "nap")
MAX_TIMER_SEGMENTS = 50
MAX_TIMER_HOURS = 24
# Allergen introduction checklist (keys shared with the web and iOS apps).
ALLERGEN_KEYS = ("peanut", "egg", "dairy", "wheat", "soy", "sesame", "treenuts", "fish", "shellfish")
ALLERGEN_TRIES = 3
# Add page buttons that can be hidden from Settings (shared by the web and iOS apps).
QUICK_BUTTON_KEYS = ("quickFeed", "pumped", "customFeed", "breastfeed", "poo", "wee", "nap", "food", "note", "medicine")
# Measurement limits (sanity bounds, not clinical limits).
MIN_LENGTH_CM, MAX_LENGTH_CM = 30.0, 130.0
MIN_HEAD_CM, MAX_HEAD_CM = 20.0, 60.0
BABY_SEX_VALUES = {"boy", "girl"}
DEFAULT_QUICK_FEED_ML = 120
# Poo is stored as a code; the client renders it as emoji.
# Nappy changes: "wee", or 1-3 poos ("gun" kept so older entries stay valid).
POO_VALUES = {"wee", "1", "2", "3", "gun"}
MAX_BABY_NAME_LENGTH = 40
# One-off migration: notes that were exactly a poo button value become the poo field.
POO_NOTE_MIGRATION = {"💩": "1", "💩💩": "2", "💩💩💩": "3", "🔫": "gun"}


class ValidationError(ValueError):
    pass


@app.errorhandler(ValidationError)
def handle_validation_error(error):
    return jsonify({"error": str(error)}), 400


def get_payload():
    # Import replays each item through the normal save endpoints.
    override = g.get("payload_override")
    if override is not None:
        if not isinstance(override, dict):
            raise ValidationError("Invalid item")
        return override
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise ValidationError("Invalid JSON body")
    return payload


def require_id(payload):
    value = payload.get("id")
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_ID_LENGTH:
        raise ValidationError("Invalid id")
    return value


def require_timestamp(payload, key):
    value = payload.get(key)
    if not isinstance(value, str) or not ISO_TIMESTAMP_RE.match(value):
        raise ValidationError(f"Invalid {key}")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValidationError(f"Invalid {key}") from None
    return value


def to_int(value, name, maximum, allow_none=False):
    if value is None and allow_none:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValidationError(f"Invalid {name}")
    try:
        number = float(value)
    except ValueError:
        raise ValidationError(f"Invalid {name}") from None
    if not math.isfinite(number) or number < 0 or number > maximum:
        raise ValidationError(f"Invalid {name}")
    return int(round(number))


FEED_SESSION_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def optional_feed_session(value):
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not FEED_SESSION_RE.match(value.strip()):
        raise ValidationError("Invalid feedSession")
    return value.strip()


def id_exists(conn, table, entry_id):
    return conn.execute(f"SELECT 1 FROM {table} WHERE id = ?", (entry_id,)).fetchone() is not None


def next_version(conn):
    """Next value of the global change counter (call inside the write transaction)."""
    conn.execute("UPDATE sync_state SET version = version + 1 WHERE id = 1")
    return conn.execute("SELECT version FROM sync_state WHERE id = 1").fetchone()[0]


def record_deletion(conn, kind, item_id):
    conn.execute(
        "INSERT OR REPLACE INTO deletions (kind, id, version, deleted_at) VALUES (?, ?, ?, ?)",
        (kind, item_id, next_version(conn), datetime.now(LOCAL_TZ).isoformat()),
    )


def clear_deletion(conn, kind, item_id):
    conn.execute("DELETE FROM deletions WHERE kind = ? AND id = ?", (kind, item_id))


def validate_iso_date(value):
    if not isinstance(value, str):
        raise ValueError("Invalid date")
    cleaned = value.strip()
    datetime.strptime(cleaned, "%Y-%m-%d")
    return cleaned


def get_auth_row(conn):
    return conn.execute(
        """
        SELECT password_hash, password_updated_at
        FROM auth_settings
        WHERE id = 1
        """
    ).fetchone()


def is_password_configured():
    with get_db() as conn:
        row = get_auth_row(conn)
    return bool(row and row["password_hash"])


def hash_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def bearer_token():
    header = request.headers.get("Authorization", "")
    if header.lower().startswith("bearer "):
        token = header[7:].strip()
        return token or None
    return None


def is_authenticated():
    """Web app: session cookie. iOS app: `Authorization: Bearer <token>`."""
    if session.get("authenticated"):
        return True
    if "token_ok" not in g:
        token = bearer_token()
        ok = False
        if token:
            with get_db() as conn:
                row = conn.execute(
                    "SELECT token_hash FROM api_tokens WHERE token_hash = ?", (hash_token(token),)
                ).fetchone()
                if row:
                    ok = True
                    conn.execute(
                        "UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?",
                        (datetime.now(LOCAL_TZ).isoformat(), row["token_hash"]),
                    )
        g.token_ok = ok
    return g.token_ok


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not is_authenticated():
            return jsonify({"error": "Authentication required"}), 401
        return view(*args, **kwargs)

    return wrapped


def _client_key():
    return request.remote_addr or "unknown"


def login_retry_after():
    """Seconds until this client may try again, or 0 if not locked out."""
    now = time.monotonic()
    with _login_lock:
        record = _login_failures.get(_client_key())
        if not record:
            return 0
        locked_until = record.get("locked_until", 0)
        if locked_until > now:
            return int(locked_until - now) + 1
        return 0


def record_login_failure():
    now = time.monotonic()
    with _login_lock:
        # Drop stale records so the dict can't grow unbounded.
        for key in [k for k, v in _login_failures.items() if now - v["first"] > LOGIN_WINDOW_SECONDS and v.get("locked_until", 0) <= now]:
            del _login_failures[key]
        record = _login_failures.setdefault(_client_key(), {"first": now, "count": 0})
        record["count"] += 1
        if record["count"] >= LOGIN_MAX_FAILURES:
            record["locked_until"] = now + LOGIN_LOCKOUT_SECONDS
            record["first"] = now
            record["count"] = 0


def clear_login_failures():
    with _login_lock:
        _login_failures.pop(_client_key(), None)


def set_logged_in():
    session.clear()
    session["authenticated"] = True
    session.permanent = True


def backup_database(label):
    """Consistent copy of the DB next to it, e.g. before a data migration."""
    if not DB_PATH.exists():
        return None
    stamp = datetime.now(LOCAL_TZ).strftime("%Y%m%d-%H%M%S")
    target_path = DATA_DIR / f"littletrack-{label}-{stamp}.sqlite3"
    source = sqlite3.connect(DB_PATH)
    target = sqlite3.connect(target_path)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    return target_path


def table_exists(conn, name):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
    ).fetchone() is not None


def migration_needed():
    """True when init_db is about to change existing data or schema (triggers a backup first)."""
    if not DB_PATH.exists():
        return False
    with get_db() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(entries)").fetchall()}
        if not columns:
            return False
        if "poo" not in columns or "nap_minutes" not in columns:
            return True
        if not table_exists(conn, "measurements"):
            return True
        if "version" not in columns:
            return True
        if "breast_left_seconds" not in columns or "food" not in columns or "medicine" not in columns:
            return True
        pumped_columns = {row["name"] for row in conn.execute("PRAGMA table_info(pumped_logs)").fetchall()}
        if pumped_columns and "left_ml" not in pumped_columns:
            return True
        placeholders = ",".join("?" for _ in POO_NOTE_MIGRATION)
        pending = conn.execute(
            f"SELECT COUNT(*) FROM entries WHERE milk_ml IS NULL AND poo IS NULL AND TRIM(notes) IN ({placeholders})",
            tuple(POO_NOTE_MIGRATION),
        ).fetchone()[0]
        return pending > 0


def init_db():
    """Create missing tables/columns. Additive only: never drops or rebuilds tables."""
    if migration_needed():
        backup_path = backup_database("pre-migration")
        print(f"Backed up database to {backup_path} before migrating", flush=True)

    with get_db() as conn:
        columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(entries)").fetchall()
        }

        if not columns:
            conn.execute(
                """
                CREATE TABLE entries (
                  id TEXT PRIMARY KEY,
                  milk_ml INTEGER,
                  notes TEXT,
                  feed_session TEXT,
                  poo TEXT,
                  nap_minutes INTEGER,
                  breast_left_seconds INTEGER,
                  breast_right_seconds INTEGER,
                  breast_both_seconds INTEGER,
                  food TEXT,
                  medicine TEXT,
                  medicine_dose TEXT,
                  timestamp TEXT NOT NULL,
                  created_at TEXT NOT NULL
                )
                """
            )
        else:
            required = {"id", "timestamp", "created_at"}
            if not required.issubset(columns):
                raise RuntimeError(
                    f"entries table is missing required columns: {sorted(required - columns)}. "
                    "Refusing to start rather than rebuild the table."
                )
            for name, column_type in (
                ("milk_ml", "INTEGER"),
                ("notes", "TEXT"),
                ("feed_session", "TEXT"),
                ("poo", "TEXT"),
                ("nap_minutes", "INTEGER"),
                ("breast_left_seconds", "INTEGER"),
                ("breast_right_seconds", "INTEGER"),
                ("breast_both_seconds", "INTEGER"),
                ("food", "TEXT"),
                ("medicine", "TEXT"),
                ("medicine_dose", "TEXT"),
            ):
                if name not in columns:
                    conn.execute(f"ALTER TABLE entries ADD COLUMN {name} {column_type}")

        # Move poo-button notes into the poo field (idempotent; other notes untouched).
        for note_text, poo_value in POO_NOTE_MIGRATION.items():
            conn.execute(
                """
                UPDATE entries SET poo = ?, notes = ''
                WHERE milk_ml IS NULL AND poo IS NULL AND TRIM(notes) = ?
                """,
                (poo_value, note_text),
            )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              feeding_times TEXT NOT NULL,
              baby_weight_grams INTEGER,
              baby_dob TEXT,
              baby_weight_updated_at TEXT
            )
            """
        )
        settings_columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(settings)").fetchall()
        }
        if "baby_dob" not in settings_columns:
            conn.execute("ALTER TABLE settings ADD COLUMN baby_dob TEXT")
        if "baby_weight_updated_at" not in settings_columns:
            conn.execute("ALTER TABLE settings ADD COLUMN baby_weight_updated_at TEXT")
        if "baby_sex" not in settings_columns:
            conn.execute("ALTER TABLE settings ADD COLUMN baby_sex TEXT")
        if "baby_name" not in settings_columns:
            conn.execute("ALTER TABLE settings ADD COLUMN baby_name TEXT")
        if "quick_feed_ml" not in settings_columns:
            conn.execute("ALTER TABLE settings ADD COLUMN quick_feed_ml INTEGER")
        if "hidden_quick_buttons" not in settings_columns:
            conn.execute("ALTER TABLE settings ADD COLUMN hidden_quick_buttons TEXT")
        if "quick_button_order" not in settings_columns:
            conn.execute("ALTER TABLE settings ADD COLUMN quick_button_order TEXT")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS weight_logs (
              id TEXT PRIMARY KEY,
              weight_grams INTEGER NOT NULL,
              date TEXT NOT NULL,
              created_at TEXT NOT NULL
            )
            """
        )
        # Measurements replace weight_logs: weight, length and head circumference per
        # entry, any of which may be blank. weight_logs is left untouched as a legacy copy.
        measurements_is_new = not table_exists(conn, "measurements")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS measurements (
              id TEXT PRIMARY KEY,
              date TEXT NOT NULL,
              weight_grams INTEGER,
              length_cm REAL,
              head_cm REAL,
              created_at TEXT NOT NULL
            )
            """
        )
        if measurements_is_new:
            # One-off copy of existing weights (runs only when the table is first created,
            # so deleting a measurement later never brings it back).
            conn.execute(
                """
                INSERT OR IGNORE INTO measurements (id, date, weight_grams, length_cm, head_cm, created_at)
                SELECT id, date, weight_grams, NULL, NULL, created_at FROM weight_logs
                """
            )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS pumped_logs (
              id TEXT PRIMARY KEY,
              milk_ml INTEGER NOT NULL,
              timestamp TEXT NOT NULL,
              created_at TEXT NOT NULL
            )
            """
        )
        # Per-breast pump amounts. milk_ml stays the total (old rows only have the total).
        pumped_columns = {row["name"] for row in conn.execute("PRAGMA table_info(pumped_logs)").fetchall()}
        for name in ("left_ml", "right_ml"):
            if name not in pumped_columns:
                conn.execute(f"ALTER TABLE pumped_logs ADD COLUMN {name} INTEGER")

        # Allergen checklist: one row per allergen, tries = JSON list of 3 dates (or null).
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS allergens (
              key TEXT PRIMARY KEY,
              tries TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              version INTEGER NOT NULL DEFAULT 0
            )
            """
        )

        # Running timers (breastfeed / nap), shared by every device. One per kind.
        # segments: JSON list of {"side", "start"} for breastfeeds (side switches); [] for naps.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS timers (
              kind TEXT PRIMARY KEY,
              id TEXT NOT NULL,
              started_at TEXT NOT NULL,
              segments TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              version INTEGER NOT NULL DEFAULT 0
            )
            """
        )

        # ---- Sync support (iOS app) ----
        # Every write stamps the row with the next value of a global counter, and deletes
        # leave a tombstone, so a client can ask for "everything changed since version N".
        for table in ("entries", "pumped_logs", "measurements"):
            table_columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
            if "version" not in table_columns:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN version INTEGER NOT NULL DEFAULT 0")
            conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_version ON {table}(version)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_state (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              version INTEGER NOT NULL
            )
            """
        )
        conn.execute("INSERT OR IGNORE INTO sync_state (id, version) VALUES (1, 0)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS deletions (
              kind TEXT NOT NULL,
              id TEXT NOT NULL,
              version INTEGER NOT NULL,
              deleted_at TEXT NOT NULL,
              PRIMARY KEY (kind, id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_deletions_version ON deletions(version)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS api_tokens (
              token_hash TEXT PRIMARY KEY,
              device_name TEXT,
              created_at TEXT NOT NULL,
              last_used_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS auth_settings (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              password_hash TEXT,
              password_updated_at TEXT
            )
            """
        )

        existing_settings = conn.execute(
            "SELECT id FROM settings WHERE id = 1"
        ).fetchone()
        if not existing_settings:
            conn.execute(
                """
                INSERT INTO settings (id, feeding_times, baby_weight_grams, baby_dob, baby_weight_updated_at)
                VALUES (1, ?, NULL, NULL, NULL)
                """,
                (json.dumps(DEFAULT_FEEDING_TIMES),),
            )

        existing_auth = conn.execute(
            "SELECT id FROM auth_settings WHERE id = 1"
        ).fetchone()
        if not existing_auth:
            conn.execute(
                """
                INSERT INTO auth_settings (id, password_hash, password_updated_at)
                VALUES (1, NULL, NULL)
                """
            )


def sanitize_feeding_times(values):
    if not isinstance(values, list):
        return DEFAULT_FEEDING_TIMES

    normalized = []
    for value in values:
        if not isinstance(value, str):
            continue
        cleaned = value.strip()
        if len(cleaned) != 5 or cleaned[2] != ":":
            continue
        hours, minutes = cleaned.split(":", 1)
        if not (hours.isdigit() and minutes.isdigit()):
            continue
        if int(hours) > 23 or int(minutes) > 59:
            continue
        normalized.append(f"{int(hours):02d}:{int(minutes):02d}")

    unique_sorted = sorted(set(normalized))
    return unique_sorted or DEFAULT_FEEDING_TIMES


def get_latest_weight_row(conn):
    return conn.execute(
        """
        SELECT id, weight_grams, date, created_at
        FROM measurements
        WHERE weight_grams IS NOT NULL
        ORDER BY date DESC, created_at DESC
        LIMIT 1
        """
    ).fetchone()


def normalize_quick_order(keys):
    keys = keys if isinstance(keys, list) else []
    ordered = [key for key in dict.fromkeys(keys) if key in QUICK_BUTTON_KEYS]
    return ordered + [key for key in QUICK_BUTTON_KEYS if key not in ordered]


def get_settings():
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT feeding_times, baby_weight_grams, baby_dob, baby_weight_updated_at, baby_sex, quick_feed_ml,
                   hidden_quick_buttons, quick_button_order, baby_name
            FROM settings
            WHERE id = 1
            """
        ).fetchone()
        latest_weight = get_latest_weight_row(conn)

    hidden_buttons = []
    if row and row["hidden_quick_buttons"]:
        try:
            hidden_buttons = [key for key in json.loads(row["hidden_quick_buttons"]) if key in QUICK_BUTTON_KEYS]
        except (json.JSONDecodeError, TypeError):
            hidden_buttons = []
    saved_order = []
    if row and row["quick_button_order"]:
        try:
            saved_order = json.loads(row["quick_button_order"])
        except (json.JSONDecodeError, TypeError):
            saved_order = []

    feeding_times = DEFAULT_FEEDING_TIMES
    if row and row["feeding_times"]:
        try:
            parsed = json.loads(row["feeding_times"])
        except json.JSONDecodeError:
            parsed = DEFAULT_FEEDING_TIMES
        feeding_times = sanitize_feeding_times(parsed)

    return {
        "feedingTimes": feeding_times or DEFAULT_FEEDING_TIMES,
        "babyWeightGrams": row["baby_weight_grams"] if row else None,
        "babyDob": row["baby_dob"] if row else None,
        "babySex": row["baby_sex"] if row else None,
        # Shown in place of "mlkbar" next to the logo when set.
        "babyName": row["baby_name"] if row and row["baby_name"] else None,
        # Amount for the one-tap feed button (shared by the web and iOS apps).
        "quickFeedMl": (row["quick_feed_ml"] if row and row["quick_feed_ml"] else DEFAULT_QUICK_FEED_ML),
        # Add page buttons turned off in Settings.
        "hiddenQuickButtons": hidden_buttons,
        # Add page button order (every key, saved order first, new buttons at the end).
        "quickButtonOrder": normalize_quick_order(saved_order),
        "babyWeightUpdatedAt": row["baby_weight_updated_at"] if row else None,
        "latestWeightGrams": latest_weight["weight_grams"] if latest_weight else None,
        "latestWeightDate": latest_weight["date"] if latest_weight else None,
    }


MAX_IMPORT_BYTES = 25 * 1024 * 1024


@app.before_request
def allow_large_import():
    # Everything else keeps the small 64 KB request limit.
    if request.path == "/api/import":
        request.max_content_length = MAX_IMPORT_BYTES


@app.before_request
def protect_routes():
    path = request.path or "/"
    public_paths = {
        "/login",
        "/api/auth/status",
        "/api/auth/login",
        "/api/auth/setup",
        "/api/auth/logout",
        "/api/auth/token",
        "/healthz",
        "/manifest.webmanifest",
        "/style.css",
        "/app.js",
        "/sw.js",
    }

    if path.startswith("/icons/") or path.startswith("/branding/") or path.startswith("/fonts/"):
        return None

    if path in public_paths:
        if path == "/login" and is_authenticated():
            return redirect(url_for("root"))
        return None

    if path.startswith("/api/") and not is_authenticated():
        return jsonify({"error": "Authentication required"}), 401

    if (path == "/" or path.endswith(".html")) and not is_authenticated():
        return redirect(url_for("login_page"))

    return None


@app.after_request
def set_cache_headers(response):
    path = request.path or "/"
    if path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    elif request.args.get("v") and (path.endswith(".js") or path.endswith(".css") or path.endswith(".webmanifest")):
        # Versioned asset URLs (?v=...) change whenever the file changes.
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif path.startswith("/fonts/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif path.startswith("/icons/") or path.startswith("/branding/"):
        response.headers["Cache-Control"] = "public, max-age=86400"
    elif path == "/" or path.endswith(".html") or path == "/login":
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/healthz")
def healthz():
    # Unauthenticated liveness check for the container healthcheck. Reveals nothing.
    try:
        with get_db() as conn:
            conn.execute("SELECT 1 FROM settings LIMIT 1").fetchone()
    except sqlite3.Error:
        return jsonify({"ok": False}), 503
    return jsonify({"ok": True})


@app.get("/weight.html")
@app.get("/info.html")
def page_moved():
    # Weight became Measurements, and Info was folded into it; keep old bookmarks working.
    return redirect("/measurements.html", code=301)


@app.get("/login")
def login_page():
    return send_from_directory(PUBLIC_DIR, "login.html")


@app.get("/api/auth/status")
def auth_status():
    return jsonify(
        {
            "authenticated": is_authenticated(),
            "passwordConfigured": is_password_configured(),
            "sessionDays": SESSION_DAYS,
        }
    )


def normalise_setup_code(value):
    return re.sub(r"[^A-Z0-9]", "", value.upper()) if isinstance(value, str) else ""


def ensure_setup_code():
    """On a fresh server, make sure a setup code exists and print it to the logs."""
    if is_password_configured():
        SETUP_CODE_PATH.unlink(missing_ok=True)
        return None
    code = SETUP_CODE_PATH.read_text(encoding="utf-8").strip() if SETUP_CODE_PATH.exists() else ""
    if not code:
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O or 1/I
        raw = "".join(secrets.choice(alphabet) for _ in range(8))
        code = f"{raw[:4]}-{raw[4:]}"
        SETUP_CODE_PATH.write_text(code + "\n", encoding="utf-8")
        os.chmod(SETUP_CODE_PATH, 0o600)
    print(f"[mlkbar] First-time setup code: {code} (also in data/setup-code.txt)", flush=True)
    return code


@app.post("/api/auth/setup")
def auth_setup():
    if is_password_configured():
        return jsonify({"error": "Password already configured"}), 409

    retry_after = login_retry_after()
    if retry_after:
        response = jsonify({"error": f"Too many attempts. Try again in {max(1, retry_after // 60)} min."})
        response.headers["Retry-After"] = str(retry_after)
        return response, 429

    payload = request.get_json(silent=True) or {}
    expected = normalise_setup_code(ensure_setup_code())
    given = normalise_setup_code(payload.get("setupCode") if isinstance(payload, dict) else None)
    if not expected or not secrets.compare_digest(given, expected):
        record_login_failure()
        return jsonify({"error": "Incorrect setup code. Find it in the server logs or data/setup-code.txt."}), 403

    password = payload.get("password") if isinstance(payload, dict) else None
    password = password.strip() if isinstance(password, str) else ""
    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters"}), 400

    password_hash = generate_password_hash(password)
    updated_at = datetime.now(LOCAL_TZ).isoformat()
    with get_db() as conn:
        conn.execute(
            """
            UPDATE auth_settings
            SET password_hash = ?, password_updated_at = ?
            WHERE id = 1
            """,
            (password_hash, updated_at),
        )

    SETUP_CODE_PATH.unlink(missing_ok=True)
    clear_login_failures()
    set_logged_in()
    return jsonify({"ok": True})


@app.post("/api/auth/login")
def auth_login():
    retry_after = login_retry_after()
    if retry_after:
        response = jsonify({"error": f"Too many attempts. Try again in {max(1, retry_after // 60)} min."})
        response.headers["Retry-After"] = str(retry_after)
        return response, 429

    payload = request.get_json(silent=True) or {}
    password = payload.get("password") if isinstance(payload, dict) else None
    if not isinstance(password, str):
        password = ""

    with get_db() as conn:
        row = get_auth_row(conn)

    if not row or not row["password_hash"]:
        return jsonify({"error": "Password not configured"}), 409

    if not check_password_hash(row["password_hash"], password):
        record_login_failure()
        return jsonify({"error": "Incorrect password"}), 401

    clear_login_failures()
    set_logged_in()
    return jsonify({"ok": True})


@app.post("/api/auth/logout")
def auth_logout():
    session.clear()
    return jsonify({"ok": True})


@app.post("/api/auth/token")
def auth_token_create():
    """iOS app login: exchange the shared password for a long-lived bearer token."""
    retry_after = login_retry_after()
    if retry_after:
        response = jsonify({"error": f"Too many attempts. Try again in {max(1, retry_after // 60)} min."})
        response.headers["Retry-After"] = str(retry_after)
        return response, 429

    payload = request.get_json(silent=True) or {}
    password = payload.get("password") if isinstance(payload, dict) else None
    device_name = payload.get("deviceName") if isinstance(payload, dict) else None
    if not isinstance(password, str):
        password = ""
    if not isinstance(device_name, str):
        device_name = "iOS device"
    device_name = device_name.strip()[:80] or "iOS device"

    with get_db() as conn:
        row = get_auth_row(conn)
    if not row or not row["password_hash"]:
        return jsonify({"error": "Password not configured. Set it up in the web app first."}), 409
    if not check_password_hash(row["password_hash"], password):
        record_login_failure()
        return jsonify({"error": "Incorrect password"}), 401

    clear_login_failures()
    token = secrets.token_urlsafe(32)
    with get_db() as conn:
        conn.execute(
            "INSERT INTO api_tokens (token_hash, device_name, created_at) VALUES (?, ?, ?)",
            (hash_token(token), device_name, datetime.now(LOCAL_TZ).isoformat()),
        )
    return jsonify({"token": token})


@app.delete("/api/auth/token")
def auth_token_revoke():
    """iOS app logout: revoke the token used for this request."""
    token = bearer_token()
    if token:
        with get_db() as conn:
            conn.execute("DELETE FROM api_tokens WHERE token_hash = ?", (hash_token(token),))
    return jsonify({"ok": True})


@app.get("/api/auth/tokens")
@login_required
def auth_tokens_list():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT device_name, created_at, last_used_at FROM api_tokens ORDER BY created_at DESC"
        ).fetchall()
    return jsonify(
        [{"deviceName": r["device_name"], "createdAt": r["created_at"], "lastUsedAt": r["last_used_at"]} for r in rows]
    )


@app.post("/api/auth/tokens/revoke-all")
@login_required
def auth_tokens_revoke_all():
    """Sign out every iOS device (e.g. a lost phone)."""
    with get_db() as conn:
        removed = conn.execute("DELETE FROM api_tokens").rowcount
    return jsonify({"ok": True, "revoked": removed})


COMBINED_ENTRIES_SQL = """
    SELECT id, milk_ml, notes, feed_session, poo, nap_minutes,
           breast_left_seconds, breast_right_seconds, breast_both_seconds, left_ml, right_ml, food,
           medicine, medicine_dose, timestamp, created_at, version, entry_type
    FROM (
      SELECT id, milk_ml, notes, feed_session, poo, nap_minutes,
             breast_left_seconds, breast_right_seconds, breast_both_seconds,
             NULL AS left_ml, NULL AS right_ml, food, medicine, medicine_dose,
             timestamp, created_at, version, 'feed' AS entry_type
      FROM entries
      UNION ALL
      SELECT id, milk_ml, '' AS notes, NULL AS feed_session, NULL AS poo, NULL AS nap_minutes,
             NULL AS breast_left_seconds, NULL AS breast_right_seconds, NULL AS breast_both_seconds,
             left_ml, right_ml, NULL AS food, NULL AS medicine, NULL AS medicine_dose,
             timestamp, created_at, version, 'pumped' AS entry_type
      FROM pumped_logs
    )
"""


def serialize_entry(row):
    return {
        "id": row["id"],
        "milkMl": row["milk_ml"],
        "notes": row["notes"] or "",
        "feedSession": row["feed_session"],
        "poo": row["poo"],
        "napMinutes": row["nap_minutes"],
        "breastLeftSeconds": row["breast_left_seconds"],
        "breastRightSeconds": row["breast_right_seconds"],
        "breastBothSeconds": row["breast_both_seconds"],
        "pumpLeftMl": row["left_ml"],
        "pumpRightMl": row["right_ml"],
        "food": row["food"],
        "medicine": row["medicine"],
        "medicineDose": row["medicine_dose"],
        "timestamp": row["timestamp"],
        "createdAt": row["created_at"],
        "entryType": row["entry_type"],
        "version": row["version"],
    }


def optional_query_timestamp(name):
    value = request.args.get(name)
    if value is None or value == "":
        return None
    return require_timestamp({name: value}, name)


@app.get("/api/entries")
@login_required
def list_entries():
    # Optional range filter: ?from=<ISO>&to=<ISO> (from inclusive, to exclusive).
    # All timestamps share the toISOString() format, so string comparison is correct.
    range_from = optional_query_timestamp("from")
    range_to = optional_query_timestamp("to")
    clauses, params = [], []
    if range_from:
        clauses.append("timestamp >= ?")
        params.append(range_from)
    if range_to:
        clauses.append("timestamp < ?")
        params.append(range_to)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""

    with get_db() as conn:
        rows = conn.execute(
            f"{COMBINED_ENTRIES_SQL}{where} ORDER BY timestamp DESC, created_at DESC",
            params,
        ).fetchall()
    return jsonify([serialize_entry(row) for row in rows])


@app.get("/api/entries/<entry_id>")
@login_required
def get_entry(entry_id):
    with get_db() as conn:
        row = conn.execute(f"{COMBINED_ENTRIES_SQL} WHERE id = ?", (entry_id,)).fetchone()
    if not row:
        return jsonify({"error": "Not found"}), 404
    return jsonify(serialize_entry(row))


@app.post("/api/entries")
@login_required
def create_entry():
    payload = get_payload()
    entry_id = require_id(payload)
    milk_ml = to_int(payload.get("milkMl"), "milkMl", MAX_MILK_ML, allow_none=True)
    notes = payload.get("notes") or ""
    if not isinstance(notes, str) or len(notes) > MAX_NOTES_LENGTH:
        raise ValidationError("Invalid notes")
    notes = notes.strip()
    poo = payload.get("poo")
    if poo in (None, ""):
        poo = None
    elif not isinstance(poo, str) or poo not in POO_VALUES:
        raise ValidationError("Invalid poo")
    nap_minutes = to_int(payload.get("napMinutes"), "napMinutes", MAX_NAP_MINUTES, allow_none=True)
    if nap_minutes == 0:
        raise ValidationError("Invalid napMinutes")
    breast = {
        side: to_int(payload.get(key), key, MAX_BREAST_SECONDS, allow_none=True) or None
        for side, key in (
            ("left", "breastLeftSeconds"),
            ("right", "breastRightSeconds"),
            ("both", "breastBothSeconds"),
        )
    }
    has_breast = any(breast.values())
    food = payload.get("food")
    if food in (None, ""):
        food = None
    elif not isinstance(food, str) or not food.strip() or len(food.strip()) > MAX_FOOD_LENGTH:
        raise ValidationError("Invalid food")
    else:
        food = food.strip()
    medicine = payload.get("medicine")
    if medicine in (None, ""):
        medicine = None
    elif not isinstance(medicine, str) or not medicine.strip() or len(medicine.strip()) > MAX_MEDICINE_LENGTH:
        raise ValidationError("Invalid medicine")
    else:
        medicine = medicine.strip()
    medicine_dose = payload.get("medicineDose")
    if medicine_dose in (None, "") or medicine is None:
        medicine_dose = None
    elif not isinstance(medicine_dose, str) or len(medicine_dose.strip()) > MAX_DOSE_LENGTH:
        raise ValidationError("Invalid medicineDose")
    else:
        medicine_dose = medicine_dose.strip() or None
    if (milk_ml is None and not notes and poo is None and nap_minutes is None and not has_breast
            and food is None and medicine is None):
        raise ValidationError("Entry needs milkMl, notes, poo, napMinutes, breastfeed time, food or medicine")
    feed_session = optional_feed_session(payload.get("feedSession"))
    timestamp = require_timestamp(payload, "timestamp")
    created_at = require_timestamp(payload, "createdAt")

    with get_db() as conn:
        if id_exists(conn, "pumped_logs", entry_id):
            return jsonify({"error": "id already used by a pumped entry"}), 409
        # Upsert: the client edits an entry by re-posting it with the same id.
        conn.execute(
            """
            INSERT OR REPLACE INTO entries (
              id, milk_ml, notes, feed_session, poo, nap_minutes,
              breast_left_seconds, breast_right_seconds, breast_both_seconds, food,
              medicine, medicine_dose, timestamp, created_at, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                entry_id, milk_ml, notes, feed_session, poo, nap_minutes,
                breast["left"], breast["right"], breast["both"], food,
                medicine, medicine_dose, timestamp, created_at, next_version(conn),
            ),
        )
        clear_deletion(conn, "entry", entry_id)
    return jsonify({"ok": True})


@app.delete("/api/entries/<entry_id>")
@login_required
def delete_entry(entry_id):
    with get_db() as conn:
        removed = conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,)).rowcount
        removed += conn.execute("DELETE FROM pumped_logs WHERE id = ?", (entry_id,)).rowcount
        if removed:
            record_deletion(conn, "entry", entry_id)
    return jsonify({"ok": True})


@app.get("/api/pumped")
@login_required
def list_pumped():
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT id, milk_ml, left_ml, right_ml, timestamp, created_at
            FROM pumped_logs
            ORDER BY timestamp DESC, created_at DESC
            """
        ).fetchall()
    return jsonify(
        [
            {
                "id": row["id"],
                "milkMl": row["milk_ml"],
                "pumpLeftMl": row["left_ml"],
                "pumpRightMl": row["right_ml"],
                "timestamp": row["timestamp"],
                "createdAt": row["created_at"],
                "entryType": "pumped",
            }
            for row in rows
        ]
    )


@app.post("/api/pumped")
@login_required
def create_pumped():
    payload = get_payload()
    entry_id = require_id(payload)
    left_ml = to_int(payload.get("pumpLeftMl"), "pumpLeftMl", MAX_MILK_ML, allow_none=True)
    right_ml = to_int(payload.get("pumpRightMl"), "pumpRightMl", MAX_MILK_ML, allow_none=True)
    if left_ml is None and right_ml is None:
        # Total only (older clients, or the user didn't split by breast).
        milk_ml = to_int(payload.get("milkMl"), "milkMl", MAX_MILK_ML)
    else:
        milk_ml = (left_ml or 0) + (right_ml or 0)
        if milk_ml == 0 or milk_ml > MAX_MILK_ML:
            raise ValidationError("Invalid pumped amount")
    timestamp = require_timestamp(payload, "timestamp")
    created_at = require_timestamp(payload, "createdAt")

    with get_db() as conn:
        if id_exists(conn, "entries", entry_id):
            return jsonify({"error": "id already used by a feed entry"}), 409
        conn.execute(
            """
            INSERT OR REPLACE INTO pumped_logs (
              id, milk_ml, left_ml, right_ml, timestamp, created_at, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (entry_id, milk_ml, left_ml, right_ml, timestamp, created_at, next_version(conn)),
        )
        clear_deletion(conn, "entry", entry_id)
    return jsonify({"ok": True})


@app.delete("/api/pumped/<entry_id>")
@login_required
def delete_pumped(entry_id):
    with get_db() as conn:
        if conn.execute("DELETE FROM pumped_logs WHERE id = ?", (entry_id,)).rowcount:
            record_deletion(conn, "entry", entry_id)
    return jsonify({"ok": True})


def serialize_measurement(row):
    return {
        "id": row["id"],
        "date": row["date"],
        "weightGrams": row["weight_grams"],
        "lengthCm": row["length_cm"],
        "headCm": row["head_cm"],
        "createdAt": row["created_at"],
        "version": row["version"],
    }


def to_cm(value, name, minimum, maximum):
    """Optional centimetre value, rounded to 0.1 cm."""
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValidationError(f"Invalid {name}")
    try:
        number = float(value)
    except ValueError:
        raise ValidationError(f"Invalid {name}") from None
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise ValidationError(f"Invalid {name}")
    return round(number, 1)


@app.get("/api/measurements")
@login_required
def list_measurements():
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT id, date, weight_grams, length_cm, head_cm, created_at, version
            FROM measurements
            ORDER BY date DESC, created_at DESC
            """
        ).fetchall()
    return jsonify([serialize_measurement(row) for row in rows])


@app.post("/api/measurements")
@login_required
def save_measurement():
    payload = get_payload()
    measurement_id = require_id(payload)
    weight_grams = to_int(payload.get("weightGrams"), "weightGrams", MAX_WEIGHT_GRAMS, allow_none=True)
    if weight_grams == 0:
        raise ValidationError("Invalid weightGrams")
    length_cm = to_cm(payload.get("lengthCm"), "lengthCm", MIN_LENGTH_CM, MAX_LENGTH_CM)
    head_cm = to_cm(payload.get("headCm"), "headCm", MIN_HEAD_CM, MAX_HEAD_CM)
    if weight_grams is None and length_cm is None and head_cm is None:
        raise ValidationError("Add at least one of weight, length or head circumference")
    try:
        date_value = validate_iso_date(payload.get("date"))
    except ValueError:
        raise ValidationError("Invalid date") from None
    created_at = require_timestamp(payload, "createdAt")

    with get_db() as conn:
        # Upsert: the client edits a measurement by re-posting it with the same id.
        conn.execute(
            """
            INSERT OR REPLACE INTO measurements (id, date, weight_grams, length_cm, head_cm, created_at, version)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (measurement_id, date_value, weight_grams, length_cm, head_cm, created_at, next_version(conn)),
        )
        clear_deletion(conn, "measurement", measurement_id)
    return jsonify({"ok": True})


@app.delete("/api/measurements/<measurement_id>")
@login_required
def delete_measurement(measurement_id):
    with get_db() as conn:
        if conn.execute("DELETE FROM measurements WHERE id = ?", (measurement_id,)).rowcount:
            record_deletion(conn, "measurement", measurement_id)
    return jsonify({"ok": True})


@app.get("/api/sync")
@login_required
def sync():
    """Everything changed since `since` (a version number from a previous sync).

    since=-1 (or omitted) returns all data. Apply `deleted` after the upserts.
    """
    raw = request.args.get("since", "-1")
    try:
        since = int(raw)
    except ValueError:
        raise ValidationError("Invalid since") from None
    if since < -1:
        raise ValidationError("Invalid since")

    with get_db() as conn:
        current = conn.execute("SELECT version FROM sync_state WHERE id = 1").fetchone()[0]
        entries = conn.execute(
            f"{COMBINED_ENTRIES_SQL} WHERE version > ? ORDER BY timestamp DESC, created_at DESC", (since,)
        ).fetchall()
        measurements = conn.execute(
            """
            SELECT id, date, weight_grams, length_cm, head_cm, created_at, version
            FROM measurements WHERE version > ? ORDER BY date DESC, created_at DESC
            """,
            (since,),
        ).fetchall()
        deleted = conn.execute(
            "SELECT kind, id FROM deletions WHERE version > ? ORDER BY version", (since,)
        ).fetchall() if since >= 0 else []

    return jsonify(
        {
            "version": current,
            "full": since < 0,
            "entries": [serialize_entry(row) for row in entries],
            "measurements": [serialize_measurement(row) for row in measurements],
            "deleted": [{"kind": row["kind"], "id": row["id"]} for row in deleted],
            "settings": get_settings(),
            # Always the complete list (it's tiny), so clients just replace theirs.
            "timers": list_timer_rows(),
            "allergens": list_allergen_rows(),
        }
    )


# ---- Export / import (a full JSON backup; same format as the iOS app's export) ----

EXPORT_FORMAT = 1


@app.get("/api/export")
@login_required
def export_data():
    with get_db() as conn:
        entries = conn.execute(f"{COMBINED_ENTRIES_SQL} ORDER BY timestamp, created_at").fetchall()
        measurements = conn.execute(
            "SELECT id, date, weight_grams, length_cm, head_cm, created_at, version FROM measurements ORDER BY date, created_at"
        ).fetchall()
    body = {
        "app": "mlkbar",
        "format": EXPORT_FORMAT,
        "exportedAt": datetime.now(LOCAL_TZ).isoformat(),
        "settings": get_settings(),
        "entries": [serialize_entry(row) for row in entries],
        "measurements": [serialize_measurement(row) for row in measurements],
        "allergens": list_allergen_rows(),
    }
    response = jsonify(body)
    stamp = datetime.now(LOCAL_TZ).strftime("%Y-%m-%d")
    response.headers["Content-Disposition"] = f'attachment; filename="mlkbar-export-{stamp}.json"'
    response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/api/import")
@login_required
def import_data():
    """Adds or updates everything in an export file. Nothing is ever deleted, and
    importing the same file twice changes nothing (items keep their ids)."""
    payload = get_payload()
    if payload.get("app") != "mlkbar":
        raise ValidationError("That isn't an mlkbar export file")
    counts = {"entries": 0, "measurements": 0, "allergens": 0, "settings": 0, "skipped": 0}

    def replay(handler, item, *args):
        g.payload_override = item
        try:
            result = handler(*args)
            status = result[1] if isinstance(result, tuple) else 200
            return status < 400
        except ValidationError:
            return False
        finally:
            g.payload_override = None

    for item in payload.get("entries") or []:
        handler = create_pumped if isinstance(item, dict) and item.get("entryType") == "pumped" else create_entry
        counts["entries" if replay(handler, item) else "skipped"] += 1
    for item in payload.get("measurements") or []:
        counts["measurements" if replay(save_measurement, item) else "skipped"] += 1
    for item in payload.get("allergens") or []:
        key = item.get("key") if isinstance(item, dict) else None
        counts["allergens" if key in ALLERGEN_KEYS and replay(save_allergen, item, key) else "skipped"] += 1
    settings = payload.get("settings")
    if isinstance(settings, dict):
        merged = {**get_settings(), **settings}
        counts["settings" if replay(save_settings, merged) else "skipped"] += 1
    return jsonify({"ok": True, **counts})



# ---- PDF report (shareable summary; the iOS app builds the same report itself) ----

ALLERGEN_NAMES = {
    "peanut": "Peanut", "egg": "Egg", "dairy": "Dairy", "wheat": "Wheat", "soy": "Soy",
    "sesame": "Sesame", "treenuts": "Tree nuts", "fish": "Fish", "shellfish": "Shellfish",
}


def _fmt_minutes(total):
    total = int(round(total or 0))
    if total < 60:
        return f"{total}m"
    return f"{total // 60}h {total % 60}m" if total % 60 else f"{total // 60}h"


def report_days(rows, days):
    """Per local day: feeds, breastfeeds, pumped, naps, wees, poos, foods."""
    by_day = {}
    for row in rows:
        local = datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")).astimezone(LOCAL_TZ)
        key = local.date().isoformat()
        day = by_day.setdefault(key, {"feeds": 0, "feed_ml": 0, "breast": 0, "breast_s": 0, "pumped": 0,
                                      "naps": 0, "nap_min": 0, "wees": 0, "poos": 0, "foods": [], "medicines": []})
        if row["entry_type"] == "pumped":
            day["pumped"] += row["milk_ml"] or 0
        elif row["milk_ml"] is not None:
            day["feeds"] += 1
            day["feed_ml"] += row["milk_ml"]
        elif (row["breast_left_seconds"] or 0) + (row["breast_right_seconds"] or 0) + (row["breast_both_seconds"] or 0):
            day["breast"] += 1
            day["breast_s"] += (row["breast_left_seconds"] or 0) + (row["breast_right_seconds"] or 0) + (row["breast_both_seconds"] or 0)
        elif row["medicine"]:
            dose = f" {row['medicine_dose']}" if row["medicine_dose"] else ""
            day["medicines"].append(f"{row['medicine']}{dose} ({local.strftime('%H:%M')})")
        elif row["food"]:
            if row["food"].strip().lower() not in [f.lower() for f in day["foods"]]:
                day["foods"].append(row["food"].strip())
        elif row["poo"]:
            day["wees" if row["poo"] == "wee" else "poos"] += 1
        elif row["nap_minutes"]:
            day["naps"] += 1
            day["nap_min"] += row["nap_minutes"]
    keys = sorted(by_day)
    if days:
        start = (datetime.now(LOCAL_TZ).date() - timedelta(days=days - 1)).isoformat()
        keys = [k for k in keys if k >= start]
    return [(k, by_day[k]) for k in keys]


def build_report_pdf(days):
    from io import BytesIO
    from xml.sax.saxutils import escape

    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    pink = colors.HexColor("#fb0589")
    soft = colors.HexColor("#ffe3f0")
    muted = colors.HexColor("#6f5f69")
    text = colors.HexColor("#2a1f26")
    title = ParagraphStyle("t", fontName="Helvetica-Bold", fontSize=20, leading=24, textColor=pink, spaceAfter=6)
    heading = ParagraphStyle("h", fontName="Helvetica-Bold", fontSize=12, textColor=pink, spaceBefore=10, spaceAfter=4)
    body = ParagraphStyle("b", fontName="Helvetica", fontSize=9.5, textColor=text, leading=13)
    small = ParagraphStyle("s", parent=body, fontSize=9, textColor=muted)

    settings = get_settings()
    with get_db() as conn:
        rows = conn.execute(f"{COMBINED_ENTRIES_SQL} ORDER BY timestamp").fetchall()
        measurements = conn.execute(
            "SELECT date, weight_grams, length_cm, head_cm FROM measurements ORDER BY date DESC, created_at DESC LIMIT 6"
        ).fetchall()
    allergens = {row["key"]: row["tries"] for row in list_allergen_rows()}
    day_rows = report_days(rows, days)

    name = settings.get("babyName") or "mlkbar"
    story = [Paragraph(f"{name} report", title)]
    period = f"Last {days} days" if days else "All time"
    if day_rows:
        period += f" ({datetime.fromisoformat(day_rows[0][0]).strftime('%-d %b %Y')} to {datetime.fromisoformat(day_rows[-1][0]).strftime('%-d %b %Y')})"
    lines = [period, f"Created {datetime.now(LOCAL_TZ).strftime('%-d %b %Y, %H:%M')}"]
    if settings.get("babyDob"):
        dob = datetime.fromisoformat(settings["babyDob"]).date()
        age_days = (datetime.now(LOCAL_TZ).date() - dob).days
        age = f"{age_days // 7} weeks" if age_days < 120 else f"{int(age_days / 30.4375)} months"
        lines.insert(0, f"Born {dob.strftime('%-d %b %Y')} ({age} old)")
    story.append(Paragraph(" · ".join(lines), small))

    # Summary (averages per day over the period)
    if day_rows:
        n = len(day_rows)
        total = lambda key: sum(d[key] for _, d in day_rows)  # noqa: E731
        summary = [
            ["Feeds / day", f"{total('feeds') / n:.1f}", "Milk / day", f"{round(total('feed_ml') / n)} ml"],
            ["Breastfeeds / day", f"{total('breast') / n:.1f}", "Breastfeeding / day", _fmt_minutes(total("breast_s") / 60 / n)],
            ["Pumped / day", f"{round(total('pumped') / n)} ml", "Naps / day", f"{total('naps') / n:.1f} ({_fmt_minutes(total('nap_min') / n)})"],
            ["Wees", str(total("wees")), "Poos", str(total("poos"))],
        ]
        story += [Paragraph("Summary", heading)]
        table = Table(summary, hAlign="LEFT", colWidths=[38 * mm, 42 * mm, 42 * mm, 46 * mm])
        table.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, -1), "Helvetica", 9.5),
            ("TEXTCOLOR", (0, 0), (0, -1), muted), ("TEXTCOLOR", (2, 0), (2, -1), muted),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(table)

    # Daily table
    story.append(Paragraph("Day by day", heading))
    if day_rows:
        data = [["Date", "Feeds", "Breastfed", "Pumped", "Naps", "Wees", "Poos"]]
        for key, d in reversed(day_rows):
            data.append([
                datetime.fromisoformat(key).strftime("%a %-d %b"),
                f"{d['feeds']} · {d['feed_ml']} ml" if d["feeds"] else "–",
                f"{d['breast']} · {_fmt_minutes(d['breast_s'] / 60)}" if d["breast"] else "–",
                f"{d['pumped']} ml" if d["pumped"] else "–",
                f"{d['naps']} · {_fmt_minutes(d['nap_min'])}" if d["naps"] else "–",
                str(d["wees"]) if d["wees"] else "–",
                str(d["poos"]) if d["poos"] else "–",
            ])
        table = Table(data, repeatRows=1, hAlign="LEFT", colWidths=[26 * mm, 30 * mm, 28 * mm, 22 * mm, 28 * mm, 14 * mm, 14 * mm])
        table.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, -1), "Helvetica", 9),
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
            ("BACKGROUND", (0, 0), (-1, 0), pink), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, soft]),
            ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]))
        story.append(table)
    else:
        story.append(Paragraph("Nothing logged in this period.", small))

    # Foods
    food_days = [(k, d["foods"]) for k, d in reversed(day_rows) if d["foods"]]
    if food_days:
        story.append(Paragraph("Foods", heading))
        for key, foods in food_days:
            story.append(Paragraph(f"<b>{datetime.fromisoformat(key).strftime('%a %-d %b')}</b>: {escape(', '.join(foods))}", body))

    # Medicines
    medicine_days = [(k, d["medicines"]) for k, d in reversed(day_rows) if d["medicines"]]
    if medicine_days:
        story.append(Paragraph("Medicines", heading))
        for key, meds in medicine_days:
            text = ", ".join(escape(m) for m in sorted(meds, key=lambda m: m[-6:]))
            story.append(Paragraph(f"<b>{datetime.fromisoformat(key).strftime('%a %-d %b')}</b>: {text}", body))

    # Measurements
    if measurements:
        story.append(Paragraph("Measurements", heading))
        data = [["Date", "Weight", "Length", "Head"]]
        for m in measurements:
            data.append([
                datetime.fromisoformat(m["date"]).strftime("%-d %b %Y"),
                f"{m['weight_grams'] / 1000:.2f} kg" if m["weight_grams"] else "–",
                f"{m['length_cm']:.1f} cm" if m["length_cm"] else "–",
                f"{m['head_cm']:.1f} cm" if m["head_cm"] else "–",
            ])
        table = Table(data, hAlign="LEFT", colWidths=[34 * mm, 30 * mm, 30 * mm, 30 * mm])
        table.setStyle(TableStyle([
            ("FONT", (0, 0), (-1, -1), "Helvetica", 9),
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
            ("BACKGROUND", (0, 0), (-1, 0), pink), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, soft]),
        ]))
        story.append(table)

    # Allergens
    story.append(Paragraph("Allergens", heading))
    parts = []
    for key in ALLERGEN_KEYS:
        tries = sum(1 for t in allergens.get(key, []) if t)
        parts.append(f"{ALLERGEN_NAMES[key]} {'done' if tries >= ALLERGEN_TRIES else f'{tries}/{ALLERGEN_TRIES}'}")
    story.append(Paragraph(" · ".join(parts), body))

    buffer = BytesIO()
    SimpleDocTemplate(buffer, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                      title=f"{name} report", author="mlkbar").build(story)
    return buffer.getvalue()


@app.get("/api/report.pdf")
@login_required
def report_pdf():
    raw = request.args.get("days", "30")
    days = None if raw == "all" else to_int(raw, "days", 3650)
    pdf = build_report_pdf(days or None)
    response = app.response_class(pdf, mimetype="application/pdf")
    stamp = datetime.now(LOCAL_TZ).strftime("%Y-%m-%d")
    response.headers["Content-Disposition"] = f'attachment; filename="mlkbar-report-{stamp}.pdf"'
    response.headers["Cache-Control"] = "no-store"
    return response


# ---- Allergen introduction checklist ----

def list_allergen_rows():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM allergens ORDER BY key").fetchall()
    return [
        {"key": row["key"], "tries": json.loads(row["tries"]), "updatedAt": row["updated_at"], "version": row["version"]}
        for row in rows
    ]


@app.get("/api/allergens")
@login_required
def list_allergens():
    return jsonify(list_allergen_rows())


@app.post("/api/allergens/<key>")
@login_required
def save_allergen(key):
    """Body: {tries: [date|null, date|null, date|null]} (local YYYY-MM-DD dates)."""
    if key not in ALLERGEN_KEYS:
        raise ValidationError("Unknown allergen")
    tries = get_payload().get("tries")
    if not isinstance(tries, list) or len(tries) != ALLERGEN_TRIES:
        raise ValidationError("tries must be a list of 3 dates or nulls")
    cleaned = []
    for value in tries:
        if value in (None, ""):
            cleaned.append(None)
            continue
        try:
            cleaned.append(validate_iso_date(value))
        except ValueError:
            raise ValidationError("Invalid date") from None
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO allergens (key, tries, updated_at, version) VALUES (?, ?, ?, ?)",
            (key, json.dumps(cleaned), datetime.now(LOCAL_TZ).isoformat(), next_version(conn)),
        )
    return jsonify({"ok": True, "key": key, "tries": cleaned})


# ---- Running timers (breastfeed / nap) ----

def parse_ts(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def serialize_timer(row):
    return {
        "kind": row["kind"],
        "id": row["id"],
        "startedAt": row["started_at"],
        "segments": json.loads(row["segments"]),
        "updatedAt": row["updated_at"],
        "version": row["version"],
    }


def list_timer_rows():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM timers ORDER BY kind").fetchall()
    return [serialize_timer(row) for row in rows]


def require_timer_kind(kind):
    if kind not in TIMER_KINDS:
        raise ValidationError("Invalid timer kind")
    return kind


def validate_segments(kind, started_at, raw):
    """Breastfeed: ordered list of side switches, the first starting at startedAt. Nap: none."""
    if kind == "nap":
        if raw not in (None, []):
            raise ValidationError("Nap timers have no segments")
        return []
    if not isinstance(raw, list) or not raw or len(raw) > MAX_TIMER_SEGMENTS:
        raise ValidationError("Invalid segments")
    segments, previous = [], None
    for item in raw:
        if not isinstance(item, dict) or item.get("side") not in BREAST_SIDES:
            raise ValidationError("Invalid segment side")
        start = require_timestamp(item, "start")
        if previous is not None and start < previous:
            raise ValidationError("Segments must be in time order")
        segments.append({"side": item["side"], "start": start})
        previous = start
    if segments[0]["start"] != started_at:
        raise ValidationError("First segment must start at startedAt")
    return segments


def segment_seconds(started_at, segments, ended_at):
    """Seconds per side ({'left', 'right', 'both'}) from the switch points up to ended_at."""
    totals = {side: 0 for side in BREAST_SIDES}
    points = segments or [{"side": "both", "start": started_at}]
    for index, segment in enumerate(points):
        start = parse_ts(segment["start"])
        end = parse_ts(points[index + 1]["start"]) if index + 1 < len(points) else ended_at
        totals[segment["side"]] += max(0, int(round((end - start).total_seconds())))
    return totals


@app.get("/api/timers")
@login_required
def list_timers():
    return jsonify(list_timer_rows())


@app.put("/api/timers/<kind>")
@login_required
def save_timer(kind):
    """Start a timer, or update it (e.g. switch breast). Body: {id, startedAt, segments}."""
    require_timer_kind(kind)
    payload = get_payload()
    timer_id = require_id(payload)
    started_at = require_timestamp(payload, "startedAt")
    segments = validate_segments(kind, started_at, payload.get("segments"))
    now = datetime.now(LOCAL_TZ).isoformat()
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM timers WHERE kind = ?", (kind,)).fetchone()
        if existing and existing["id"] != timer_id:
            # Someone else already started one (e.g. the partner's phone). Return theirs.
            row = conn.execute("SELECT * FROM timers WHERE kind = ?", (kind,)).fetchone()
            return jsonify({"error": "A timer is already running", "timer": serialize_timer(row)}), 409
        conn.execute(
            """
            INSERT OR REPLACE INTO timers (kind, id, started_at, segments, updated_at, version)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (kind, timer_id, started_at, json.dumps(segments), now, next_version(conn)),
        )
        row = conn.execute("SELECT * FROM timers WHERE kind = ?", (kind,)).fetchone()
    return jsonify({"ok": True, "timer": serialize_timer(row)})


@app.post("/api/timers/<kind>/stop")
@login_required
def stop_timer(kind):
    """Stop a timer and log it as an entry, in one step.

    Body: {id, endedAt, entryId, createdAt}. Safe to retry: if the timer is already gone
    and the entry exists, it reports success. Breastfeeds are timestamped at the start,
    naps at the end (wake-up time), matching the manual popups.
    """
    require_timer_kind(kind)
    payload = get_payload()
    timer_id = require_id(payload)
    ended_at_text = require_timestamp(payload, "endedAt")
    entry_id = require_id({"id": payload.get("entryId")})
    created_at = require_timestamp(payload, "createdAt")
    with get_db() as conn:
        row = conn.execute("SELECT * FROM timers WHERE kind = ?", (kind,)).fetchone()
        if not row or row["id"] != timer_id:
            if id_exists(conn, "entries", entry_id):
                return jsonify({"ok": True, "alreadyStopped": True, "entryId": entry_id})
            return jsonify({"error": "That timer isn't running any more"}), 409
        started_at = row["started_at"]
        start, end = parse_ts(started_at), parse_ts(ended_at_text)
        if end < start:
            end = start
        if end - start > timedelta(hours=MAX_TIMER_HOURS):
            raise ValidationError("Timer ran for more than 24 hours; enter it manually instead")
        segments = json.loads(row["segments"])
        created = False
        if kind == "nap":
            seconds = (end - start).total_seconds()
            if seconds >= 30:
                minutes = min(MAX_NAP_MINUTES, max(1, int(round(seconds / 60))))
                conn.execute(
                    """
                    INSERT OR REPLACE INTO entries (id, milk_ml, notes, feed_session, poo, nap_minutes,
                      timestamp, created_at, version)
                    VALUES (?, NULL, '', NULL, NULL, ?, ?, ?, ?)
                    """,
                    # Naps are logged at wake-up time, like the manual nap popup.
                    (entry_id, minutes, ended_at_text if end > start else started_at, created_at, next_version(conn)),
                )
                created = True
        else:
            totals = segment_seconds(started_at, segments, end)
            if sum(totals.values()) >= 5:
                values = [min(MAX_BREAST_SECONDS, totals[side]) or None for side in BREAST_SIDES]
                conn.execute(
                    """
                    INSERT OR REPLACE INTO entries (id, milk_ml, notes, feed_session, poo, nap_minutes,
                      breast_left_seconds, breast_right_seconds, breast_both_seconds,
                      timestamp, created_at, version)
                    VALUES (?, NULL, '', NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
                    """,
                    (entry_id, *values, started_at, created_at, next_version(conn)),
                )
                created = True
        if created:
            clear_deletion(conn, "entry", entry_id)
        conn.execute("DELETE FROM timers WHERE kind = ?", (kind,))
        next_version(conn)  # timers aren't tombstoned: /api/sync always sends the full list
        entry = conn.execute(f"{COMBINED_ENTRIES_SQL} WHERE id = ?", (entry_id,)).fetchone() if created else None
    return jsonify({"ok": True, "entry": serialize_entry(entry) if entry else None})


@app.delete("/api/timers/<kind>")
@login_required
def cancel_timer(kind):
    """Discard a running timer without logging anything. ?id= guards against cancelling
    a different timer that someone else started in the meantime."""
    require_timer_kind(kind)
    timer_id = request.args.get("id")
    with get_db() as conn:
        row = conn.execute("SELECT id FROM timers WHERE kind = ?", (kind,)).fetchone()
        if row and (not timer_id or row["id"] == timer_id):
            conn.execute("DELETE FROM timers WHERE kind = ?", (kind,))
            next_version(conn)  # timers aren't tombstoned: /api/sync always sends the full list
    return jsonify({"ok": True})


@app.get("/api/settings")
@login_required
def read_settings():
    return jsonify(get_settings())


@app.post("/api/settings")
@login_required
def save_settings():
    payload = get_payload()
    feeding_times = sanitize_feeding_times(payload.get("feedingTimes"))
    baby_weight_grams = to_int(payload.get("babyWeightGrams"), "babyWeightGrams", MAX_WEIGHT_GRAMS, allow_none=True)
    baby_dob = payload.get("babyDob")
    if baby_dob is not None and not isinstance(baby_dob, str):
        raise ValidationError("Invalid babyDob")
    if isinstance(baby_dob, str):
        baby_dob = baby_dob.strip() or None
    if baby_dob is not None:
        try:
            baby_dob = validate_iso_date(baby_dob)
        except ValueError:
            raise ValidationError("Invalid babyDob") from None
    baby_sex = payload.get("babySex")
    if baby_sex in (None, ""):
        baby_sex = None
    elif baby_sex not in BABY_SEX_VALUES:
        raise ValidationError("Invalid babySex")
    has_name = "babyName" in payload
    baby_name = payload.get("babyName") if has_name else None
    if has_name:
        if baby_name is not None and not isinstance(baby_name, str):
            raise ValidationError("Invalid babyName")
        baby_name = (baby_name or "").strip() or None
        if baby_name and len(baby_name) > MAX_BABY_NAME_LENGTH:
            raise ValidationError("Name is too long")
    # Optional: clients that don't send it (older app versions) leave it unchanged.
    has_quick_feed = "quickFeedMl" in payload
    quick_feed_ml = to_int(payload.get("quickFeedMl"), "quickFeedMl", MAX_MILK_ML, allow_none=True) if has_quick_feed else None
    if has_quick_feed and quick_feed_ml is not None and quick_feed_ml < 1:
        raise ValidationError("Invalid quickFeedMl")
    has_hidden = "hiddenQuickButtons" in payload
    hidden_buttons = payload.get("hiddenQuickButtons") if has_hidden else None
    if has_hidden:
        if hidden_buttons is None:
            hidden_buttons = []
        # Unknown keys (from newer apps) are ignored rather than rejected.
        if not isinstance(hidden_buttons, list) or any(not isinstance(key, str) for key in hidden_buttons):
            raise ValidationError("Invalid hiddenQuickButtons")
        hidden_buttons = [key for key in QUICK_BUTTON_KEYS if key in hidden_buttons]
    has_order = "quickButtonOrder" in payload
    quick_order = payload.get("quickButtonOrder") if has_order else None
    if has_order:
        if not isinstance(quick_order, list) or any(not isinstance(key, str) for key in quick_order):
            raise ValidationError("Invalid quickButtonOrder")
        quick_order = normalize_quick_order(quick_order)

    with get_db() as conn:
        existing = conn.execute(
            """
            SELECT baby_weight_grams, baby_weight_updated_at, quick_feed_ml, hidden_quick_buttons, quick_button_order,
                   baby_name
            FROM settings
            WHERE id = 1
            """
        ).fetchone()
        weight_updated_at = existing["baby_weight_updated_at"] if existing else None
        previous_weight = existing["baby_weight_grams"] if existing else None
        if baby_weight_grams != previous_weight:
            weight_updated_at = datetime.now(LOCAL_TZ).date().isoformat()
        if not has_quick_feed:
            quick_feed_ml = existing["quick_feed_ml"] if existing else None
        hidden_json = json.dumps(hidden_buttons) if has_hidden else (existing["hidden_quick_buttons"] if existing else None)
        order_json = json.dumps(quick_order) if has_order else (existing["quick_button_order"] if existing else None)
        if not has_name:
            baby_name = existing["baby_name"] if existing else None

        conn.execute(
            """
            INSERT INTO settings (id, feeding_times, baby_weight_grams, baby_dob, baby_weight_updated_at, baby_sex, quick_feed_ml,
                                  hidden_quick_buttons, quick_button_order, baby_name)
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              feeding_times = excluded.feeding_times,
              baby_weight_grams = excluded.baby_weight_grams,
              baby_dob = excluded.baby_dob,
              baby_weight_updated_at = excluded.baby_weight_updated_at,
              baby_sex = excluded.baby_sex,
              quick_feed_ml = excluded.quick_feed_ml,
              hidden_quick_buttons = excluded.hidden_quick_buttons,
              quick_button_order = excluded.quick_button_order,
              baby_name = excluded.baby_name
            """,
            (
                json.dumps(feeding_times),
                baby_weight_grams,
                baby_dob,
                weight_updated_at,
                baby_sex,
                quick_feed_ml,
                hidden_json,
                order_json,
                baby_name,
            ),
        )

    return jsonify({"ok": True})


@app.get("/")
def root():
    return send_from_directory(PUBLIC_DIR, "index.html")


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(PUBLIC_DIR, path)


init_db()
ensure_setup_code()


if __name__ == "__main__":
    # Local dev only. Production runs under gunicorn (see Dockerfile).
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "80")))
