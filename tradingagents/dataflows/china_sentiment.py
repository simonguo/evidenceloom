"""China A-share sentiment/news fetchers.

The public StockTwits/Reddit sentiment sources used for US tickers rarely
cover A-shares. This module provides a lightweight Chinese-source block for
prompt injection, using Eastmoney search and stock bar metadata without new
dependencies.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta

import requests


EASTMONEY_SEARCH_URL = "https://search-api-web.eastmoney.com/search/jsonp"
EASTMONEY_GUBA_URL = "https://gbapi.eastmoney.com/webarticlelist/api/Article/Articlelist"


def is_a_share_symbol(symbol: str) -> bool:
    raw = symbol.strip().upper()
    return (
        (len(raw) == 6 and raw.isdigit())
        or (len(raw) == 8 and raw[:2] in {"SH", "SZ"} and raw[2:].isdigit())
        or (len(raw) == 9 and raw[:6].isdigit() and raw[6:] in {".SS", ".SH", ".SZ"})
    )


def normalize_a_share_code(symbol: str) -> str:
    raw = symbol.strip().upper()
    if raw.startswith(("SH", "SZ")) and len(raw) == 8:
        raw = raw[2:]
    elif raw.endswith((".SS", ".SH", ".SZ")):
        raw = raw[:6]
    if not (len(raw) == 6 and raw.isdigit()):
        raise ValueError(f"not an A-share symbol: {symbol}")
    return raw


def fetch_china_sentiment_sources(
    symbol: str,
    start_date: str,
    end_date: str,
    limit: int = 12,
) -> str:
    code = normalize_a_share_code(symbol)
    company_name = _fetch_company_name(code)
    article_keywords = [code]
    if company_name:
        article_keywords.extend([company_name, f"{code} {company_name}"])
    articles = _merge_articles(
        _fetch_akshare_stock_news(code, start_date, end_date, limit=limit, include_recent=False),
        _fetch_eastmoney_articles(article_keywords, start_date, end_date, limit),
    )[:limit]
    recent_articles = []
    if not articles:
        recent_articles = _merge_articles(
            _fetch_akshare_stock_news(
                code,
                start_date,
                end_date,
                limit=min(limit, 8),
                include_recent=True,
            ),
            _fetch_eastmoney_articles(
                article_keywords,
                start_date,
                end_date,
                limit=min(limit, 8),
                recent_days=45,
            ),
        )[: min(limit, 8)]
    hot_keywords = _fetch_eastmoney_hot_keywords(code, limit=8)
    posts = _fetch_eastmoney_guba_posts(code, limit=8)

    lines = [
        f"## A股中文舆情数据：{company_name or code}（{code}）",
        f"时间窗口：{start_date} 至 {end_date}",
        "",
        "### 东方财富个股新闻 / 资讯搜索",
    ]
    if articles:
        for item in articles:
            lines.append(_format_article_line(item))
    elif recent_articles:
        lines.append(
            "<指定 7 天窗口内未找到新闻；以下为窗口外最近资讯，仅用于补充近期叙事，不能当作当日情绪信号>"
        )
        for item in recent_articles:
            lines.append(_format_article_line(item, prefix="窗口外近况"))
    else:
        lines.append(
            f"<未找到 {code} / {company_name or code} 在该时间窗口或最近补充窗口内的东方财富资讯结果>"
        )

    lines.extend(["", "### 东方财富人气关键词"])
    if hot_keywords:
        for item in hot_keywords:
            keyword = item.get("keyword") or "未知关键词"
            heat = item.get("heat")
            date = item.get("date") or "未知时间"
            heat_text = f"热度 {heat}" if heat not in (None, "") else "热度未知"
            lines.append(f"- [{date}] {keyword}（{heat_text}）")
    else:
        lines.append("<未获取到东方财富人气关键词；不要据此推断市场关注度为低>")

    lines.extend(["", "### 东方财富股吧"])
    if posts:
        for post in posts:
            title = post.get("title") or "无标题"
            date = post.get("date") or "未知时间"
            read_count = post.get("read_count")
            comment_count = post.get("comment_count")
            engagement = []
            if read_count not in (None, ""):
                engagement.append(f"阅读 {read_count}")
            if comment_count not in (None, ""):
                engagement.append(f"评论 {comment_count}")
            suffix = f"（{'，'.join(engagement)}）" if engagement else ""
            lines.append(f"- [{date}] {title}{suffix}")
    else:
        lines.append("<东方财富股吧接口未返回有效帖子；不要据此推断情绪为中性，只能视为数据缺失>")

    lines.extend(
        [
            "",
            "### 分析提示",
            "- 这些是中文市场资讯/股吧数据，不是 StockTwits/Reddit。",
            "- 个股新闻和资金流报道偏事件与媒体叙事；人气关键词反映关注主题，不等同于正负情绪。",
            "- 窗口外近况只能说明近期叙事背景，不能当作指定时间窗口内的强情绪证据。",
            "- 股吧若为空，应降低散户情绪部分的置信度。",
            "- 不要编造雪球、同花顺、财联社或未出现在数据块中的内容。",
        ]
    )
    return "\n".join(lines)


def _get_json(url: str, params: dict, referer: str) -> dict:
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json,text/plain,*/*",
        "Referer": referer,
    }
    response = requests.get(url, params=params, headers=headers, timeout=12)
    response.raise_for_status()
    text = response.text.strip()
    if text.startswith("jQuery(") and text.endswith(")"):
        text = text[len("jQuery(") : -1]
    return json.loads(text)


def _fetch_company_name(code: str) -> str | None:
    try:
        payload = _get_json(
            EASTMONEY_GUBA_URL,
            {"code": code, "sorttype": "0", "ps": "1", "p": "1", "from": "CommonBaPost"},
            f"https://guba.eastmoney.com/list,{code}.html",
        )
    except Exception:
        return None
    return ((payload.get("bar_info") or {}).get("ShortName") or "").strip() or None


def _fetch_eastmoney_articles(
    keywords: list[str],
    start_date: str,
    end_date: str,
    limit: int,
    recent_days: int = 0,
) -> list[dict]:
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    earliest = start - timedelta(days=recent_days)
    articles = []
    for keyword in [item for item in dict.fromkeys(keywords) if item]:
        search_param = {
            "uid": "",
            "keyword": keyword,
            "type": ["cmsArticleWebOld"],
            "client": "web",
            "clientType": "web",
            "clientVersion": "curr",
            "param": {
                "cmsArticleWebOld": {
                    "searchScope": "default",
                    "sort": "default",
                    "pageIndex": 1,
                    "pageSize": limit,
                    "preTag": "",
                    "postTag": "",
                }
            },
        }
        try:
            payload = _get_json(
                EASTMONEY_SEARCH_URL,
                {"cb": "jQuery", "param": json.dumps(search_param, ensure_ascii=False)},
                "https://so.eastmoney.com/",
            )
        except Exception:
            continue

        rows = (payload.get("result") or {}).get("cmsArticleWebOld") or []
        for row in rows:
            date_text = row.get("date") or ""
            published = _parse_datetime(date_text)
            if published and not (
                earliest <= published <= end.replace(hour=23, minute=59, second=59)
            ):
                continue
            articles.append(
                {
                    "date": date_text,
                    "title": _compact_text(row.get("title") or "", 120),
                    "content": _compact_text(row.get("content") or "", 240),
                    "source": row.get("mediaName") or "",
                    "url": row.get("url") or "",
                    "source_type": "东方财富资讯搜索",
                    "in_window": published is None
                    or start <= published <= end.replace(hour=23, minute=59, second=59),
                }
            )
    return _merge_articles(articles)[:limit]


def _fetch_akshare_stock_news(
    code: str,
    start_date: str,
    end_date: str,
    limit: int,
    include_recent: bool,
) -> list[dict]:
    try:
        import akshare as ak  # type: ignore

        frame = ak.stock_news_em(symbol=code)
    except Exception:
        return []

    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d").replace(hour=23, minute=59, second=59)
    recent_start = start - timedelta(days=45)
    rows = []
    for _, row in frame.iterrows():
        date_text = str(row.get("发布时间") or "")
        published = _parse_datetime(date_text)
        if published is None:
            continue
        in_window = start <= published <= end
        if not in_window:
            if not include_recent or not (recent_start <= published <= end):
                continue
        rows.append(
            {
                "date": date_text,
                "title": _compact_text(str(row.get("新闻标题") or ""), 120),
                "content": _compact_text(str(row.get("新闻内容") or ""), 240),
                "source": str(row.get("文章来源") or ""),
                "url": str(row.get("新闻链接") or ""),
                "source_type": "东方财富个股新闻",
                "in_window": in_window,
            }
        )
    rows.sort(key=lambda item: item.get("date") or "", reverse=True)
    return _merge_articles(rows)[:limit]


def _fetch_eastmoney_hot_keywords(code: str, limit: int) -> list[dict]:
    try:
        import akshare as ak  # type: ignore

        frame = ak.stock_hot_keyword_em(symbol=_eastmoney_rank_symbol(code))
    except Exception:
        return []

    rows = []
    for _, row in frame.head(limit).iterrows():
        rows.append(
            {
                "date": str(row.get("时间") or ""),
                "keyword": _compact_text(str(row.get("概念名称") or ""), 80),
                "heat": row.get("热度"),
            }
        )
    return rows


def _fetch_eastmoney_guba_posts(code: str, limit: int) -> list[dict]:
    try:
        payload = _get_json(
            EASTMONEY_GUBA_URL,
            {"code": code, "sorttype": "0", "ps": str(limit), "p": "1", "from": "CommonBaPost"},
            f"https://guba.eastmoney.com/list,{code}.html",
        )
    except Exception:
        return []

    posts = []
    for row in payload.get("re") or []:
        title = row.get("post_title") or row.get("title") or row.get("Title") or ""
        posts.append(
            {
                "date": row.get("post_publish_time") or row.get("date") or row.get("Date") or "",
                "title": _compact_text(title, 140),
                "read_count": row.get("post_click_count") or row.get("read_count"),
                "comment_count": row.get("post_comment_count") or row.get("comment_count"),
            }
        )
    return posts[:limit]


def _eastmoney_rank_symbol(code: str) -> str:
    return f"SH{code}" if code.startswith(("5", "6", "9")) else f"SZ{code}"


def _parse_datetime(value: str) -> datetime | None:
    text = (value or "").strip()
    for candidate, fmt in ((text[:19], "%Y-%m-%d %H:%M:%S"), (text[:10], "%Y-%m-%d")):
        try:
            return datetime.strptime(candidate, fmt)
        except ValueError:
            continue
    return None


def _merge_articles(*groups: list[dict]) -> list[dict]:
    merged = []
    seen = set()
    for group in groups:
        for item in group:
            title = item.get("title") or ""
            date = item.get("date") or ""
            key = (title, date[:10])
            if not title or key in seen:
                continue
            seen.add(key)
            merged.append(item)
    merged.sort(key=lambda item: item.get("date") or "", reverse=True)
    return merged


def _format_article_line(item: dict, prefix: str | None = None) -> str:
    title = item.get("title") or "无标题"
    source = item.get("source") or "未知来源"
    date = item.get("date") or "未知时间"
    content = _compact_text(item.get("content") or "", 180)
    url = item.get("url") or ""
    source_type = item.get("source_type") or "资讯"
    label = f"{prefix} · " if prefix else ""
    line = f"- [{label}{date} · {source_type} · {source}] {title}"
    if content:
        line += f" — 摘要：{content}"
    if url:
        line += f" Link: {url}"
    return line


def _compact_text(text: str, limit: int) -> str:
    clean = re.sub(r"<[^>]+>", "", text)
    clean = re.sub(r"\s+", " ", clean).strip()
    decoded = clean.replace("&nbsp;", " ").replace("&amp;", "&").strip()
    if len(decoded) > limit:
        return decoded[:limit] + "…"
    return decoded
