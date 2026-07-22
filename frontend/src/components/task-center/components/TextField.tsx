export function TextField({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string }) {
  return <label className="field-label">{label}<input className="field-input" type={type} autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}
