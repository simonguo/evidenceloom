"use client";

import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, createChart, HistogramSeries, type CandlestickData, type HistogramData, type IChartApi, type ISeriesApi, type Time } from "lightweight-charts";
import type { OhlcvBar } from "@/lib/types";

export function CandlestickChart({ data }: { data: OhlcvBar[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      height: 360,
      layout: {
        background: { type: ColorType.Solid, color: "#09090b" },
        textColor: "#a1a1aa",
      },
      grid: {
        vertLines: { color: "rgba(63, 63, 70, 0.35)" },
        horzLines: { color: "rgba(63, 63, 70, 0.35)" },
      },
      rightPriceScale: {
        borderColor: "#27272a",
      },
      timeScale: {
        borderColor: "#27272a",
        timeVisible: false,
      },
      crosshair: {
        vertLine: { color: "#71717a" },
        horzLine: { color: "#71717a" },
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: "rgba(113, 113, 122, 0.35)",
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });

    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart) return;

    const candleData: CandlestickData[] = data.map((bar) => ({
      time: bar.time as Time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    }));
    const volumeData: HistogramData[] = data.map((bar) => ({
      time: bar.time as Time,
      value: bar.volume,
      color: bar.close >= bar.open ? "rgba(34, 197, 94, 0.28)" : "rgba(239, 68, 68, 0.28)",
    }));

    candleSeries.setData(candleData);
    volumeSeries.setData(volumeData);
    chart.timeScale().fitContent();
  }, [data]);

  return <div ref={containerRef} className="h-[360px] w-full overflow-hidden rounded-lg border border-zinc-900 bg-zinc-950" />;
}
