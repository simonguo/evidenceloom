from tradingagents.dataflows import china_sentiment as sentiment


def test_china_sentiment_uses_recent_company_news_when_window_is_empty(monkeypatch):
    monkeypatch.setattr(sentiment, "_fetch_company_name", lambda code: "每日互动")
    monkeypatch.setattr(sentiment, "_fetch_akshare_stock_news", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        sentiment,
        "_fetch_eastmoney_articles",
        lambda *args, **kwargs: (
            [
                {
                    "date": "2026-06-23 14:38:05",
                    "title": "每日互动与武汉数据集团签署战略合作协议",
                    "content": "双方围绕数据要素流通和人工智能场景落地合作。",
                    "source": "第一财经",
                    "url": "https://example.test/news",
                    "source_type": "东方财富资讯搜索",
                    "in_window": False,
                }
            ]
            if kwargs.get("recent_days")
            else []
        ),
    )
    monkeypatch.setattr(
        sentiment,
        "_fetch_eastmoney_hot_keywords",
        lambda *args, **kwargs: [
            {"date": "2026-07-03 16:00:00", "keyword": "数据要素", "heat": 149}
        ],
    )
    monkeypatch.setattr(sentiment, "_fetch_eastmoney_guba_posts", lambda *args, **kwargs: [])

    block = sentiment.fetch_china_sentiment_sources("300766.SZ", "2026-06-26", "2026-07-03")

    assert "窗口外近况" in block
    assert "每日互动与武汉数据集团签署战略合作协议" in block
    assert "数据要素（热度 149）" in block
    assert "股吧接口未返回有效帖子" in block


def test_parse_datetime_accepts_common_eastmoney_formats():
    assert sentiment._parse_datetime("2026-06-23 14:38:05").year == 2026
    assert sentiment._parse_datetime("2026-06-23").day == 23
    assert sentiment._parse_datetime("") is None
