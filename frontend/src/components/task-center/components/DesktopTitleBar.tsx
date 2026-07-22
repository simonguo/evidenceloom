type DesktopTitleBarProps = {
  enabled: boolean;
};

export function DesktopTitleBar({ enabled }: DesktopTitleBarProps) {
  if (!enabled) return null;

  return (
    <div
      data-tauri-drag-region
      aria-hidden="true"
      className="fixed inset-x-0 top-0 z-40 h-8 select-none bg-black"
    />
  );
}
