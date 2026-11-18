#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import math
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from statistics import mean, median
from typing import Iterable
from zoneinfo import ZoneInfo

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


BASE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = BASE_DIR / "data" / "littletrack.db"
DEFAULT_REPORT_DIR = BASE_DIR / "reports"
LOCAL_TZ = ZoneInfo("Australia/Melbourne")
OFFSET_THRESHOLDS = (15, 30, 45, 60, 90, 120)


@dataclass
class FeedRow:
    id: str
    milk_ml: int
    notes: str
    feed_session: str | None
    timestamp: str
    created_at: str
    session_dt: datetime
    logged_dt: datetime
    offset_minutes: int | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a LittleTrack PDF report.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH, help="Path to littletrack.db")
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output PDF path. Defaults to baby-tracker/reports/littletrack-report-YYYY-MM-DD.pdf",
    )
    return parser.parse_args()


def parse_iso(value: str) -> datetime:
    if value.endswith("Z"):
        value = f"{value[:-1]}+00:00"
    return datetime.fromisoformat(value)


def to_local(value: str) -> datetime:
    return parse_iso(value).astimezone(LOCAL_TZ)


def choose_scheduled_datetime(logged_dt: datetime, session_time: str) -> datetime:
    hour, minute = [int(part) for part in session_time.split(":")]
    base = logged_dt.replace(hour=hour, minute=minute, second=0, microsecond=0)
    candidates = [base + timedelta(days=delta) for delta in (-1, 0, 1)]
    return min(candidates, key=lambda item: abs((logged_dt - item).total_seconds()))


def format_minutes(value: float | int | None) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "-"
    rounded = int(round(value))
    sign = "+" if rounded > 0 else ""
    return f"{sign}{rounded} min"


def format_ml(value: float | int | None) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "-"
    return f"{round(value, 1):g} ml"


def format_pct(value: float | None) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "-"
    return f"{value:.1f}%"


def time_sort_key(value: str) -> tuple[int, int]:
    hour, minute = [int(part) for part in value.split(":")]
    return hour, minute


def safe_mean(values: Iterable[float]) -> float | None:
    values = list(values)
    return mean(values) if values else None


def safe_median(values: Iterable[float]) -> float | None:
    values = list(values)
    return median(values) if values else None


def open_db(db_path: Path) -> sqlite3.Connection:
    """Open read-only so the report can never modify app data."""
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.execute("select 1 from settings limit 1")
    except sqlite3.OperationalError:
        # Some network filesystems reject read-only URI opens; fall back to a normal open.
        conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def weight_on(weights: list[tuple[str, int]], day: str) -> int | None:
    """Latest logged weight on or before `day` (YYYY-MM-DD); earliest weight if none before."""
    if not weights:
        return None
    candidate = weights[0][1]
    for date, grams in weights:
        if date <= day:
            candidate = grams
        else:
            break
    return candidate


def load_data(db_path: Path) -> tuple[dict, list[FeedRow], int]:
    conn = open_db(db_path)

    settings_row = conn.execute(
        "select feeding_times, baby_weight_grams, baby_dob, baby_weight_updated_at from settings"
    ).fetchone()
    if settings_row is None:
        raise RuntimeError("LittleTrack settings row is missing.")

    note_count = conn.execute(
        "select count(*) from entries where milk_ml is null and trim(coalesce(notes, '')) <> ''"
    ).fetchone()[0]

    rows = conn.execute(
        """
        select id, milk_ml, notes, feed_session, timestamp, created_at
        from entries
        where milk_ml is not null
        order by timestamp asc, created_at asc
        """
    ).fetchall()
    has_measurements = conn.execute(
        "select 1 from sqlite_master where type = 'table' and name = 'measurements'"
    ).fetchone()
    weight_table = "measurements" if has_measurements else "weight_logs"
    weight_rows = conn.execute(
        f"select date, weight_grams from {weight_table} "
        "where weight_grams is not null order by date asc, created_at asc"
    ).fetchall()
    pumped_rows = conn.execute(
        "select milk_ml, timestamp from pumped_logs order by timestamp asc"
    ).fetchall()
    conn.close()

    feeds: list[FeedRow] = []
    for row in rows:
        session_dt = to_local(row["timestamp"])
        logged_dt = to_local(row["created_at"] or row["timestamp"])
        offset_minutes = None
        if row["feed_session"]:
            scheduled_dt = choose_scheduled_datetime(logged_dt, row["feed_session"])
            offset_minutes = round((logged_dt - scheduled_dt).total_seconds() / 60)
        feeds.append(
            FeedRow(
                id=row["id"],
                milk_ml=row["milk_ml"],
                notes=row["notes"] or "",
                feed_session=row["feed_session"],
                timestamp=row["timestamp"],
                created_at=row["created_at"] or row["timestamp"],
                session_dt=session_dt,
                logged_dt=logged_dt,
                offset_minutes=offset_minutes,
            )
        )

    settings = {
        "feeding_times": json.loads(settings_row["feeding_times"]),
        "baby_weight_grams": settings_row["baby_weight_grams"],
        "baby_dob": settings_row["baby_dob"],
        "baby_weight_updated_at": settings_row["baby_weight_updated_at"],
        # Weight history from the Weight page (the settings weight above is a legacy field).
        "weights": [(row["date"], row["weight_grams"]) for row in weight_rows],
        "pumped": [(to_local(row["timestamp"]).date().isoformat(), row["milk_ml"]) for row in pumped_rows],
    }
    return settings, feeds, note_count


def build_metrics(settings: dict, feeds: list[FeedRow], note_count: int) -> dict:
    daily = defaultdict(list)
    by_window = defaultdict(list)
    scoped = []
    legacy = []

    for feed in feeds:
        daily[feed.session_dt.date().isoformat()].append(feed)
        if feed.feed_session:
            scoped.append(feed)
            by_window[feed.feed_session].append(feed)
        else:
            legacy.append(feed)

    day_labels = sorted(daily)
    complete_day_labels = day_labels[:-1] if len(day_labels) > 1 else []

    weights = settings["weights"]
    if not weights and settings["baby_weight_grams"]:
        weights = [("0000-00-00", settings["baby_weight_grams"])]

    def target_for(day: str) -> float | None:
        # 150 ml/kg/day using the weight logged on or before that day.
        grams = weight_on(weights, day)
        return grams * 150 / 1000 if grams else None

    latest_weight = weights[-1] if weights else None
    recommended_daily_ml = target_for(day_labels[-1]) if day_labels else None
    offsets = [feed.offset_minutes for feed in scoped if feed.offset_minutes is not None]

    threshold_rows = []
    for limit in OFFSET_THRESHOLDS:
        hits = sum(1 for offset in offsets if abs(offset) <= limit)
        threshold_rows.append(
            {
                "window": f"Within {limit} min",
                "count": hits,
                "pct": (hits / len(offsets) * 100) if offsets else None,
            }
        )

    current_times = settings["feeding_times"]
    historical_only = sorted([window for window in by_window if window not in current_times], key=time_sort_key)

    window_rows = []
    for window in sorted(by_window, key=time_sort_key):
        items = by_window[window]
        window_rows.append(
            {
                "window": window,
                "feeds": len(items),
                "avg_ml": safe_mean(feed.milk_ml for feed in items),
                "median_ml": safe_median(feed.milk_ml for feed in items),
                "avg_offset": safe_mean(feed.offset_minutes for feed in items if feed.offset_minutes is not None),
                "median_offset": safe_median(
                    feed.offset_minutes for feed in items if feed.offset_minutes is not None
                ),
            }
        )

    def summarize_days(labels: list[str]) -> dict:
        day_groups = [daily[label] for label in labels]
        if not day_groups:
            return {
                "days": 0,
                "avg_ml": None,
                "median_ml": None,
                "avg_feeds": None,
                "median_feeds": None,
                "days_meeting_target": None,
                "avg_target_pct": None,
            }

        totals = [sum(feed.milk_ml for feed in group) for group in day_groups]
        counts = [len(group) for group in day_groups]
        targets = [target_for(label) for label in labels]
        scored = [(total, target) for total, target in zip(totals, targets) if target]
        return {
            "days": len(day_groups),
            "avg_ml": mean(totals),
            "median_ml": median(totals),
            "avg_feeds": mean(counts),
            "median_feeds": median(counts),
            "days_meeting_target": sum(1 for total, target in scored if total >= target) if scored else None,
            "avg_target_pct": mean(total / target * 100 for total, target in scored) if scored else None,
        }

    pumped_by_day = defaultdict(int)
    for day, ml in settings["pumped"]:
        pumped_by_day[day] += ml or 0
    pumped_complete_days = [day for day in sorted(pumped_by_day) if not day_labels or day < day_labels[-1]]

    ranked_days = sorted(
        (
            {
                "date": label,
                "total_ml": sum(feed.milk_ml for feed in items),
                "feeds": len(items),
            }
            for label, items in daily.items()
        ),
        key=lambda item: (item["total_ml"], item["feeds"], item["date"]),
        reverse=True,
    )

    ranked_days_low = sorted(
        ranked_days,
        key=lambda item: (item["total_ml"], item["feeds"], item["date"]),
    )

    return {
        "generated_at": datetime.now(tz=LOCAL_TZ),
        "first_feed": feeds[0].session_dt if feeds else None,
        "last_feed": feeds[-1].session_dt if feeds else None,
        "feed_count": len(feeds),
        "note_count": note_count,
        "legacy_feed_count": len(legacy),
        "scoped_feed_count": len(scoped),
        "window_rows": window_rows,
        "threshold_rows": threshold_rows,
        "historical_only_windows": historical_only,
        "recommended_daily_ml": recommended_daily_ml,
        "summary_all_days": summarize_days(day_labels),
        "summary_complete_days": summarize_days(complete_day_labels),
        "pumped_count": len(settings["pumped"]),
        "pumped_total_ml": sum(ml or 0 for _, ml in settings["pumped"]),
        "pumped_days": len(pumped_by_day),
        "pumped_avg_ml_per_day": safe_mean(pumped_by_day[day] for day in pumped_complete_days),
        "pumped_avg_session_ml": safe_mean(ml for _, ml in settings["pumped"] if ml is not None),
        "pumped_last_7_days_ml": safe_mean(pumped_by_day[day] for day in pumped_complete_days[-7:]),
        "latest_weight_grams": latest_weight[1] if latest_weight else None,
        "latest_weight_date": latest_weight[0] if latest_weight and latest_weight[0] != "0000-00-00" else None,
        "overall_avg_feed_ml": safe_mean(feed.milk_ml for feed in feeds),
        "overall_median_feed_ml": safe_median(feed.milk_ml for feed in feeds),
        "late_count": sum(1 for offset in offsets if offset > 0),
        "early_count": sum(1 for offset in offsets if offset < 0),
        "on_time_count": sum(1 for offset in offsets if offset == 0),
        "avg_late_minutes": safe_mean(offset for offset in offsets if offset > 0),
        "avg_early_minutes": safe_mean(offset for offset in offsets if offset < 0),
        "top_days": ranked_days[:5],
        "low_days": ranked_days_low[:5],
        "current_feeding_times": current_times,
        "baby_weight_grams": settings["baby_weight_grams"],
        "baby_dob": settings["baby_dob"],
        "baby_weight_updated_at": settings["baby_weight_updated_at"],
    }


def build_pdf(output_path: Path, metrics: dict) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    doc = SimpleDocTemplate(
        str(output_path),
        pagesize=A4,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
    )

    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="ReportTitle",
            parent=styles["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=20,
            leading=24,
            alignment=TA_CENTER,
            textColor=colors.HexColor("#16324f"),
            spaceAfter=10,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SectionHeading",
            parent=styles["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=12,
            leading=15,
            textColor=colors.HexColor("#16324f"),
            spaceBefore=10,
            spaceAfter=6,
        )
    )
    styles.add(
        ParagraphStyle(
            name="BodySmall",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=9,
            leading=12,
            alignment=TA_LEFT,
        )
    )

    story = []
    story.append(Paragraph("mlkbar Feeding Report", styles["ReportTitle"]))
    story.append(
        Paragraph(
            (
                f"Generated {metrics['generated_at']:%Y-%m-%d %H:%M} | "
                f"Feed range {metrics['first_feed']:%Y-%m-%d %H:%M} to {metrics['last_feed']:%Y-%m-%d %H:%M}"
            ),
            styles["BodySmall"],
        )
    )
    story.append(
        Paragraph(
            (
                f"Latest logged weight: {metrics['latest_weight_grams'] or '-'} g "
                f"({metrics['latest_weight_date'] or 'date unknown'}) | "
                f"DOB: {metrics['baby_dob'] or '-'}"
            ),
            styles["BodySmall"],
        )
    )
    story.append(Spacer(1, 6))

    overview_rows = [
        ["Metric", "Value"],
        ["Feed entries", str(metrics["feed_count"])],
        ["Note-only entries", str(metrics["note_count"])],
        ["Average feed amount", format_ml(metrics["overall_avg_feed_ml"])],
        ["Median feed amount", format_ml(metrics["overall_median_feed_ml"])],
        ["Feeds with stored session window", str(metrics["scoped_feed_count"])],
        ["Legacy feeds without stored window", str(metrics["legacy_feed_count"])],
        ["Current daily target (latest weight x 150 ml/kg)", format_ml(metrics["recommended_daily_ml"])],
    ]
    story.append(Paragraph("Overview", styles["SectionHeading"]))
    story.append(make_table(overview_rows, [78 * mm, 88 * mm]))

    pumped_rows = [
        ["Metric", "Value"],
        ["Pump sessions", str(metrics["pumped_count"])],
        ["Total pumped", format_ml(metrics["pumped_total_ml"])],
        ["Days with pumping", str(metrics["pumped_days"])],
        ["Average per session", format_ml(metrics["pumped_avg_session_ml"])],
        ["Average per day (complete days)", format_ml(metrics["pumped_avg_ml_per_day"])],
        ["Average per day (last 7 complete days)", format_ml(metrics["pumped_last_7_days_ml"])],
    ]
    story.append(Paragraph("Pumping", styles["SectionHeading"]))
    story.append(make_table(pumped_rows, [78 * mm, 88 * mm]))

    summary_all = metrics["summary_all_days"]
    summary_complete = metrics["summary_complete_days"]
    daily_rows = [
        ["Period", "Days", "Avg ml/day", "Median ml/day", "Avg feeds/day", "Target days", "Avg target %"],
        [
            "All days",
            str(summary_all["days"]),
            format_ml(summary_all["avg_ml"]),
            format_ml(summary_all["median_ml"]),
            f"{summary_all['avg_feeds']:.2f}" if summary_all["avg_feeds"] is not None else "-",
            (
                f"{summary_all['days_meeting_target']}/{summary_all['days']}"
                if summary_all["days_meeting_target"] is not None
                else "-"
            ),
            format_pct(summary_all["avg_target_pct"]),
        ],
        [
            "Complete days only",
            str(summary_complete["days"]),
            format_ml(summary_complete["avg_ml"]),
            format_ml(summary_complete["median_ml"]),
            f"{summary_complete['avg_feeds']:.2f}" if summary_complete["avg_feeds"] is not None else "-",
            (
                f"{summary_complete['days_meeting_target']}/{summary_complete['days']}"
                if summary_complete["days_meeting_target"] is not None
                else "-"
            ),
            format_pct(summary_complete["avg_target_pct"]),
        ],
    ]
    story.append(Paragraph("Daily Intake Summary", styles["SectionHeading"]))
    story.append(
        Paragraph(
            "Each day's target uses the weight logged on or before that day (150 ml/kg/day).",
            styles["BodySmall"],
        )
    )
    story.append(Spacer(1, 4))
    story.append(make_table(daily_rows, [32 * mm, 16 * mm, 26 * mm, 28 * mm, 28 * mm, 24 * mm, 24 * mm], small=True))

    timing_rows = [
        ["Timing measure", "Feeds", "Share"],
        *[
            [row["window"], str(row["count"]), format_pct(row["pct"])]
            for row in metrics["threshold_rows"]
        ],
        ["Logged after scheduled window", str(metrics["late_count"]), "-"],
        ["Logged before scheduled window", str(metrics["early_count"]), "-"],
        ["Exactly on scheduled minute", str(metrics["on_time_count"]), "-"],
        ["Average lateness when late", format_minutes(metrics["avg_late_minutes"]), "-"],
        ["Average earliness when early", format_minutes(metrics["avg_early_minutes"]), "-"],
    ]
    story.append(Paragraph("Window vs Bracket Time", styles["SectionHeading"]))
    story.append(
        Paragraph(
            (
                "Historical only: the app stopped recording a session window per feed in June 2026, "
                "so these stats cover only the feeds that stored one. Feeds without a window are excluded."
            ),
            styles["BodySmall"],
        )
    )
    story.append(Spacer(1, 4))
    story.append(make_table(timing_rows, [72 * mm, 36 * mm, 58 * mm]))

    window_rows = [["Window", "Feeds", "Avg ml", "Median ml", "Avg offset", "Median offset"]]
    for row in metrics["window_rows"]:
        window_rows.append(
            [
                row["window"],
                str(row["feeds"]),
                format_ml(row["avg_ml"]),
                format_ml(row["median_ml"]),
                format_minutes(row["avg_offset"]),
                format_minutes(row["median_offset"]),
            ]
        )
    story.append(Paragraph("Per-Window Breakdown", styles["SectionHeading"]))
    story.append(make_table(window_rows, [22 * mm, 16 * mm, 24 * mm, 26 * mm, 34 * mm, 34 * mm], small=True))

    if metrics["historical_only_windows"]:
        story.append(Spacer(1, 4))
        story.append(
            Paragraph(
                (
                    "Historical windows no longer in the current settings: "
                    + ", ".join(metrics["historical_only_windows"])
                ),
                styles["BodySmall"],
            )
        )

    ranked_rows = [["Highest-volume days", "Total ml", "Feeds"]]
    for row in metrics["top_days"]:
        ranked_rows.append([row["date"], format_ml(row["total_ml"]), str(row["feeds"])])
    story.append(Paragraph("Highest-Volume Days", styles["SectionHeading"]))
    story.append(make_table(ranked_rows, [68 * mm, 40 * mm, 40 * mm]))

    low_rows = [["Lowest-volume days", "Total ml", "Feeds"]]
    for row in metrics["low_days"]:
        low_rows.append([row["date"], format_ml(row["total_ml"]), str(row["feeds"])])
    story.append(Paragraph("Lowest-Volume Days", styles["SectionHeading"]))
    story.append(make_table(low_rows, [68 * mm, 40 * mm, 40 * mm]))

    doc.build(story)


def make_table(rows: list[list[str]], col_widths: list[float], small: bool = False) -> Table:
    table = Table(rows, colWidths=col_widths, repeatRows=1, hAlign="LEFT")
    body_font = 8 if small else 9
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#16324f")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 0), (-1, 0), body_font),
                ("FONTSIZE", (0, 1), (-1, -1), body_font),
                ("LEADING", (0, 0), (-1, -1), body_font + 3),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#b7c9d8")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#eef4f8")]),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    return table


def main() -> None:
    args = parse_args()
    db_path = args.db.resolve()
    report_date = datetime.now(tz=LOCAL_TZ).date().isoformat()
    output_path = (
        args.output.resolve()
        if args.output
        else (DEFAULT_REPORT_DIR / f"littletrack-report-{report_date}.pdf").resolve()
    )

    settings, feeds, note_count = load_data(db_path)
    if not feeds:
        raise RuntimeError("No feed entries found in the database.")

    metrics = build_metrics(settings, feeds, note_count)
    build_pdf(output_path, metrics)

    print(output_path)
    print(f"feeds={metrics['feed_count']}")
    print(f"scoped_feeds={metrics['scoped_feed_count']}")
    print(f"legacy_feeds={metrics['legacy_feed_count']}")
    print(f"avg_feed_ml={metrics['overall_avg_feed_ml']:.2f}")


if __name__ == "__main__":
    main()
