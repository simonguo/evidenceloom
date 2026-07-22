import { SecretField } from "@/components/task-center/components/SecretField";

type CredentialFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  showLabel: string;
  hideLabel: string;
  configured: boolean;
  configuredLabel: string;
  deleteLabel: string;
  onDelete: () => Promise<void>;
};

export function CredentialField({
  configured,
  configuredLabel,
  deleteLabel,
  onDelete,
  ...fieldProps
}: CredentialFieldProps) {
  return (
    <div className="space-y-2">
      <SecretField {...fieldProps} />
      {configured && !fieldProps.value && (
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-emerald-300">{configuredLabel}</span>
          <button
            type="button"
            onClick={() => void onDelete()}
            className="text-zinc-500 transition hover:text-rose-300"
          >
            {deleteLabel}
          </button>
        </div>
      )}
    </div>
  );
}
