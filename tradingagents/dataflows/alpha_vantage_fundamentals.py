import json
from copy import deepcopy

from .alpha_vantage_common import _make_api_request, API_BASE_URL
from .date_window import withhold_live_profile, withhold_undated_statements
from .errors import VendorUnavailableError
from .evidence_utils import business_fields, source_attempt
from tradingagents.evidence import observe_source


_OVERVIEW_FIELDS = frozenset(
    """
Symbol AssetType Name Description CIK Exchange Currency Country Sector Industry Address
OfficialSite FiscalYearEnd LatestQuarter MarketCapitalization EBITDA PERatio PEGRatio
BookValue DividendPerShare DividendYield EPS RevenuePerShareTTM ProfitMargin OperatingMarginTTM
ReturnOnAssetsTTM ReturnOnEquityTTM RevenueTTM GrossProfitTTM DilutedEPSTTM
QuarterlyEarningsGrowthYOY QuarterlyRevenueGrowthYOY AnalystTargetPrice AnalystRatingStrongBuy
AnalystRatingBuy AnalystRatingHold AnalystRatingSell AnalystRatingStrongSell TrailingPE ForwardPE
PriceToSalesRatioTTM PriceToBookRatio EVToRevenue EVToEBITDA Beta 52WeekHigh 52WeekLow
50DayMovingAverage 200DayMovingAverage SharesOutstanding DividendDate ExDividendDate
""".split()
)
_STATEMENT_FIELDS = frozenset(
    """
fiscalDateEnding reportedCurrency totalAssets totalCurrentAssets cashAndCashEquivalentsAtCarryingValue
cashAndShortTermInvestments inventory currentNetReceivables totalNonCurrentAssets propertyPlantEquipment
accumulatedDepreciationAmortizationPPE intangibleAssets intangibleAssetsExcludingGoodwill goodwill
investments longTermInvestments shortTermInvestments otherCurrentAssets otherNonCurrentAssets
totalLiabilities totalCurrentLiabilities currentAccountsPayable deferredRevenue currentDebt
shortTermDebt totalNonCurrentLiabilities capitalLeaseObligations longTermDebt currentLongTermDebt
longTermDebtNoncurrent shortLongTermDebtTotal otherCurrentLiabilities otherNonCurrentLiabilities
totalShareholderEquity treasuryStock retainedEarnings commonStock commonStockSharesOutstanding
operatingCashflow paymentsForOperatingActivities proceedsFromOperatingActivities
changeInOperatingLiabilities changeInOperatingAssets depreciationDepletionAndAmortization
capitalExpenditures changeInReceivables changeInInventory profitLoss cashflowFromInvestment
cashflowFromFinancing proceedsFromRepaymentsOfShortTermDebt paymentsForRepurchaseOfCommonStock
paymentsForRepurchaseOfEquity paymentsForRepurchaseOfPreferredStock dividendPayout
dividendPayoutCommonStock dividendPayoutPreferredStock proceedsFromIssuanceOfCommonStock
proceedsFromIssuanceOfLongTermDebtAndCapitalSecuritiesNet proceedsFromIssuanceOfPreferredStock
proceedsFromRepurchaseOfEquity proceedsFromSaleOfTreasuryStock changeInCashAndCashEquivalents
changeInExchangeRate netIncome grossProfit totalRevenue costOfRevenue costofGoodsAndServicesSold
operatingIncome sellingGeneralAndAdministrative researchAndDevelopment operatingExpenses
investmentIncomeNet netInterestIncome interestIncome interestExpense nonInterestIncome
otherNonOperatingIncome depreciation depreciationAndAmortization incomeBeforeTax incomeTaxExpense
interestAndDebtExpense netIncomeFromContinuingOperations comprehensiveIncomeNetOfTax ebit ebitda
""".split()
)


def _observed_financials(result, *, freq=None):
    try:
        payload = json.loads(result) if isinstance(result, str) else result
    except (json.JSONDecodeError, TypeError):
        payload = None
    if not isinstance(payload, dict):
        source_attempt("alpha_vantage", "unavailable")
        return "DATA_UNAVAILABLE: Alpha Vantage returned malformed financial data."
    if freq is None:
        data = business_fields(payload, _OVERVIEW_FIELDS)
    else:
        key = "quarterlyReports" if freq.lower() == "quarterly" else "annualReports"
        if not isinstance(payload.get(key), list):
            source_attempt("alpha_vantage", "unavailable")
            return "DATA_UNAVAILABLE: Alpha Vantage returned unexpected financial statements."
        data = {
            key: [
                business_fields(row, _STATEMENT_FIELDS)
                for row in payload[key]
                if isinstance(row, dict)
            ]
        }
        if isinstance(payload.get("symbol"), str):
            data["symbol"] = payload["symbol"]
    if not data or (freq is not None and not data[key]):
        source_attempt("alpha_vantage", "empty")
    observe_source(
        "alpha_vantage",
        url=API_BASE_URL,
        normalized_data=data,
        transformations=("Approved financial business fields selected",),
    )
    return json.dumps(data) if isinstance(result, str) else data


def _filter_reports_by_date(result, curr_date: str):
    """Filter fiscal periods in either JSON-string or dict payloads.

    This helper only limits the periods; it does not establish filing dates.
    The provider withholds historical statements before making the request.
    """
    if not curr_date:
        return result
    is_string = isinstance(result, str)
    try:
        payload = json.loads(result) if is_string else deepcopy(result)
    except (json.JSONDecodeError, TypeError) as exc:
        raise VendorUnavailableError(
            "Alpha Vantage returned malformed financial statements"
        ) from exc
    if not isinstance(payload, dict):
        raise VendorUnavailableError("Alpha Vantage returned unexpected financial statements")
    for key in ("annualReports", "quarterlyReports"):
        if key in payload:
            payload[key] = [
                row
                for row in payload[key]
                if row.get("fiscalDateEnding") and row["fiscalDateEnding"] <= curr_date
            ]
    return json.dumps(payload) if is_string else payload


def get_fundamentals(ticker: str, curr_date: str = None) -> str:
    """Current company overview, withheld for historical dates."""
    withheld = withhold_live_profile(curr_date, ticker)
    if withheld:
        observe_source("alpha_vantage", historical_availability="withheld")
        return withheld
    result = _make_api_request("OVERVIEW", {"symbol": ticker})
    return _observed_financials(result)


def _statement(ticker, freq, curr_date, title, endpoint):
    withheld = withhold_undated_statements(curr_date, ticker, title)
    if withheld:
        observe_source("alpha_vantage", historical_availability="withheld")
        return withheld
    result = _filter_reports_by_date(_make_api_request(endpoint, {"symbol": ticker}), curr_date)
    return _observed_financials(result, freq=freq)


def get_balance_sheet(ticker: str, freq: str = "quarterly", curr_date: str = None):
    """Balance sheet with a known-date guard for historical runs."""
    return _statement(ticker, freq, curr_date, "Balance Sheet", "BALANCE_SHEET")


def get_cashflow(ticker: str, freq: str = "quarterly", curr_date: str = None):
    """Cash flow with a known-date guard for historical runs."""
    return _statement(ticker, freq, curr_date, "Cash Flow", "CASH_FLOW")


def get_income_statement(ticker: str, freq: str = "quarterly", curr_date: str = None):
    """Income statement with a known-date guard for historical runs."""
    return _statement(ticker, freq, curr_date, "Income Statement", "INCOME_STATEMENT")
