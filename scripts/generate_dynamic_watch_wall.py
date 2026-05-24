#!/usr/bin/env python3
"""Build a static, client-side editable A-share sector watch wall."""

from __future__ import annotations

import importlib.util
import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Tuple

SKILL_SCRIPT = Path.home() / ".codex/skills/a-share-support-scan/scripts/scan_support_charts.py"
SITE_DIR = Path(__file__).resolve().parents[1]
DAYS = 100
LONG_DAYS = 760
WEEKLY_BARS = 120
MONTHLY_BARS = 72
WORKERS = 8
COMPONENT_DAYS = 100
COMPONENT_WORKERS = 10

DEFAULT_WATCHLIST = [
    "801077",
    "801033",
    "801153",
    "801963",
    "801724",
    "801012",
    "801076",
    "801179",
    "801723",
    "801992",
    "801163",
    "801971",
    "801128",
    "801104",
    "801745",
    "801713",
    "801991",
    "801178",
    "801154",
    "801152",
    "801203",
    "801206",
    "801743",
    "801742",
    "801982",
    "801143",
    "801043",
]


def load_skill_module():
    spec = importlib.util.spec_from_file_location("a_share_support_scan", SKILL_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {SKILL_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def support_state(item: Any) -> Dict[str, str]:
    metrics = item.metrics
    close = float(metrics["close"])
    df = item.df
    previous = df.iloc[:-1]
    prev_low60 = float(previous["low"].tail(60).min()) if len(previous) >= 20 else math.nan
    trend = metrics.get("trend_support")
    low_break = bool(not math.isnan(prev_low60) and close < prev_low60 * 0.995)
    trend_break = bool(trend and close < float(trend) * 0.985)

    if low_break:
        return {
            "state": "支撑失败",
            "level": "danger",
            "reason": f"收盘低于前60日低点附近，原低点约 {prev_low60:.2f}",
        }
    if trend_break:
        return {
            "state": "趋势线失守",
            "level": "danger",
            "reason": f"收盘明显低于估算趋势支撑 {float(trend):.2f}",
        }
    if metrics["setup"] in ("A支撑横盘", "B前低急刹", "C趋势回踩"):
        return {
            "state": "仍在观察",
            "level": "watch",
            "reason": "仍处于支撑/前低/趋势线观察区",
        }
    return {
        "state": "普通观察",
        "level": "neutral",
        "reason": "暂未触发明确支撑型形态",
    }


def draw_card(skill: Any, item: Any, path: Path) -> None:
    plt = skill.plt
    fig, ax = plt.subplots(1, 1, figsize=(7.2, 4.5), dpi=150)
    fig.patch.set_facecolor("#f6f7f9")
    skill.draw_panel(ax, item)
    fig.tight_layout(pad=0.8)
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)


def compact_rows(df: Any) -> List[List[Any]]:
    rows = []
    for _, row in df.tail(COMPONENT_DAYS).iterrows():
        rows.append(
            [
                str(row["date"]),
                round(float(row["open"]), 3),
                round(float(row["close"]), 3),
                round(float(row["high"]), 3),
                round(float(row["low"]), 3),
                round(float(row.get("volume", 0.0)), 2),
            ]
        )
    return rows


def fetch_component_stock(skill: Any, row: Any, board_name: str) -> Tuple[Dict[str, Any], List[List[Any]]]:
    code = str(row["证券代码"]).zfill(6)
    name = str(row["证券名称"])
    weight = row.get("最新权重")
    upper = board_name
    item = skill.fetch_stock_hist_tencent(code, name, upper, COMPONENT_DAYS)
    if item is None:
        raise RuntimeError("empty stock history")
    stock = {
        "code": code,
        "name": name,
        "weight": round(float(weight), 4) if weight == weight else None,
        **item.metrics,
    }
    return stock, compact_rows(item.df)


def build_components(skill: Any, index_code: str, board_name: str, components_dir: Path) -> Dict[str, Any]:
    comp = skill.ak.index_component_sw(symbol=index_code)
    comp = comp.copy()
    comp["证券代码"] = comp["证券代码"].astype(str).str.zfill(6)
    comp["最新权重"] = skill.pd.to_numeric(comp.get("最新权重", skill.np.nan), errors="coerce")
    comp = comp.sort_values("最新权重", ascending=False, na_position="last")

    stocks: List[Dict[str, Any]] = []
    histories: Dict[str, List[List[Any]]] = {}
    errors: List[Dict[str, str]] = []

    with ThreadPoolExecutor(max_workers=COMPONENT_WORKERS) as executor:
        futures = {
            executor.submit(fetch_component_stock, skill, row, board_name): str(row["证券代码"])
            for _, row in comp.iterrows()
        }
        for future in as_completed(futures):
            code = futures[future]
            try:
                stock, history = future.result()
                stocks.append(stock)
                histories[code] = history
            except Exception as exc:
                name = ""
                match = comp.loc[comp["证券代码"] == code]
                if not match.empty:
                    name = str(match.iloc[0]["证券名称"])
                errors.append({"code": code, "name": name, "error": str(exc)[:160]})

    weight_map = {
        str(row["证券代码"]): float(row["最新权重"]) if row["最新权重"] == row["最新权重"] else -1.0
        for _, row in comp.iterrows()
    }
    stocks.sort(key=lambda stock: weight_map.get(stock["code"], -1.0), reverse=True)
    payload = {
        "sector_code": index_code,
        "sector_name": board_name,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "days": COMPONENT_DAYS,
        "stocks": stocks,
        "histories": histories,
        "errors": errors,
    }
    with open(components_dir / f"{index_code}.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    return {"count": len(stocks), "errors": errors}


def chart_item(skill: Any, item: Any, df: Any, suffix: str) -> Any:
    df = df.reset_index(drop=True)
    metrics = skill.compute_metrics(df)
    return skill.ChartItem(
        code=item.code,
        name=item.name,
        upper=f"{item.upper}  {suffix}",
        df=df,
        metrics=metrics,
    )


def resample_period(df: Any, rule: str) -> Any:
    data = df.copy()
    data["date"] = skill_pd_to_datetime(data["date"])
    data = data.set_index("date")
    grouped = data.resample(rule).agg(
        {
            "open": "first",
            "close": "last",
            "high": "max",
            "low": "min",
            "volume": "sum",
            "amount": "sum",
        }
    )
    grouped = grouped.dropna(subset=["open", "close", "high", "low"]).reset_index()
    grouped["date"] = grouped["date"].dt.date
    return grouped


def skill_pd_to_datetime(values: Any) -> Any:
    import pandas as pd

    return pd.to_datetime(values)


def main() -> None:
    skill = load_skill_module()
    skill.setup_font()

    cards_dir = SITE_DIR / "cards"
    data_dir = SITE_DIR / "data"
    components_dir = data_dir / "components"
    cards_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)
    components_dir.mkdir(parents=True, exist_ok=True)

    _, info = skill.sw_second_info()
    codes = skill.realtime_codes(info)

    items: List[Any] = []
    errors: List[Dict[str, str]] = []
    with ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = {
            executor.submit(skill.fetch_hist_with_tencent_quote, code, info, LONG_DAYS): code
            for code in codes
        }
        for future in as_completed(futures):
            code = futures[future]
            try:
                item = future.result()
                if item:
                    items.append(item)
            except Exception as exc:
                name = str(info.get(code, {}).get("行业名称", ""))
                errors.append({"code": code, "name": name, "error": str(exc)[:160]})

    items.sort(key=lambda item: (item.upper, item.name))

    for child in ["daily", "weekly", "monthly"]:
        (cards_dir / child).mkdir(parents=True, exist_ok=True)

    existing = {str(path.relative_to(cards_dir)) for path in cards_dir.glob("**/*.png")}
    expected = set()
    for item in items:
        expected.update(
            {
                f"daily/{item.code}.png",
                f"weekly/{item.code}.png",
                f"monthly/{item.code}.png",
            }
        )
    for stale in existing - expected:
        (cards_dir / stale).unlink(missing_ok=True)

    components_meta: Dict[str, Dict[str, Any]] = {}
    for stale in components_dir.glob("*.json"):
        if stale.stem not in DEFAULT_WATCHLIST:
            stale.unlink(missing_ok=True)

    sectors = []
    for item in items:
        daily = chart_item(skill, item, item.df.tail(DAYS), "日线")
        weekly_df = resample_period(item.df, "W-FRI").tail(WEEKLY_BARS)
        monthly_df = resample_period(item.df, "M").tail(MONTHLY_BARS)
        weekly = chart_item(skill, item, weekly_df, "周线")
        monthly = chart_item(skill, item, monthly_df, "月线")

        draw_card(skill, daily, cards_dir / "daily" / f"{item.code}.png")
        draw_card(skill, weekly, cards_dir / "weekly" / f"{item.code}.png")
        draw_card(skill, monthly, cards_dir / "monthly" / f"{item.code}.png")
        state = support_state(item)
        component_info = None
        if item.code in DEFAULT_WATCHLIST:
            try:
                result = build_components(skill, item.code, item.name, components_dir)
                component_info = {
                    "path": f"data/components/{item.code}.json",
                    "count": result["count"],
                    "error_count": len(result["errors"]),
                }
                components_meta[item.code] = component_info
                errors.extend(
                    {
                        "code": err["code"],
                        "name": f"{item.name}/{err.get('name', '')}",
                        "error": err["error"],
                    }
                    for err in result["errors"]
                )
            except Exception as exc:
                errors.append({"code": item.code, "name": f"{item.name}成分股", "error": str(exc)[:160]})
        sectors.append(
            {
                "code": item.code,
                "name": item.name,
                "upper": item.upper,
                "components": component_info,
                "images": {
                    "daily": f"cards/daily/{item.code}.png",
                    "weekly": f"cards/weekly/{item.code}.png",
                    "monthly": f"cards/monthly/{item.code}.png",
                },
                "image": f"cards/daily/{item.code}.png",
                **item.metrics,
                **state,
            }
        )

    generated_at = time.strftime("%Y-%m-%d %H:%M:%S")
    payload = {
        "generated_at": generated_at,
        "days": DAYS,
        "source": "申万二级行业日线；当日申万日线延迟时，用腾讯板块行情补当天K线。",
        "default_watchlist": DEFAULT_WATCHLIST,
        "components_meta": components_meta,
        "sectors": sectors,
        "errors": errors,
    }
    with open(data_dir / "sectors.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    with open(data_dir / "default_watchlist.json", "w", encoding="utf-8") as f:
        json.dump(DEFAULT_WATCHLIST, f, ensure_ascii=False, indent=2)

    print(
        json.dumps(
            {
                "generated_at": generated_at,
                "count": len(sectors),
                "default_watchlist_count": len(DEFAULT_WATCHLIST),
                "errors": errors,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
