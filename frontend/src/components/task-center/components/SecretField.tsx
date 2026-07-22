"use client";

import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

type SecretFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  showLabel: string;
  hideLabel: string;
};

export function SecretField({ label, value, onChange, placeholder, showLabel, hideLabel }: SecretFieldProps) {
  const inputId = useId();
  const [revealed, setRevealed] = useState(false);
  const toggleLabel = revealed ? hideLabel : showLabel;

  return (
    <div className="field-label">
      <label htmlFor={inputId}>{label}</label>
      <div className="relative mt-2">
        <input
          id={inputId}
          className="field-input mt-0 pr-12"
          type={revealed ? "text" : "password"}
          autoComplete="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
        <button
          type="button"
          aria-label={toggleLabel}
          aria-pressed={revealed}
          title={toggleLabel}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setRevealed((current) => !current)}
          className="absolute right-1 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-600"
        >
          {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
    </div>
  );
}
