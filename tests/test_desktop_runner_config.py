from frontend.server.run_analysis import build_config, describe_llm_config, safe_public_endpoint


def test_deepseek_payload_overrides_default_provider_and_endpoint():
    config = build_config(
        {
            "llmProvider": " Deepseek ",
            "backendUrl": "https://api.deepseek.com/",
            "quickThinkLlm": "deepseek-v4-pro",
            "deepThinkLlm": "deepseek-v4-pro",
        }
    )

    assert config["llm_provider"] == "deepseek"
    assert config["backend_url"] == "https://api.deepseek.com/"
    assert config["quick_think_llm"] == "deepseek-v4-pro"
    assert config["deep_think_llm"] == "deepseek-v4-pro"
    assert (
        describe_llm_config(config)
        == "LLM configuration: provider=deepseek; endpoint=https://api.deepseek.com/; "
        "quick=deepseek-v4-pro; deep=deepseek-v4-pro"
    )


def test_runtime_configuration_log_strips_endpoint_credentials_and_query():
    assert (
        safe_public_endpoint("https://user:secret@example.com/v1?token=hidden#fragment")
        == "https://example.com/v1"
    )
