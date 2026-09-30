/** Small shared UI helpers. */

import { useCallback, useEffect, useRef, useState } from "react";

export interface Toast {
  msg: string;
  kind: "ok" | "err";
}

export function useToast(): [Toast | null, (msg: string, kind?: "ok" | "err") => void] {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<number>();

  const show = useCallback((msg: string, kind: "ok" | "err" = "ok") => {
    setToast({ msg, kind });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [toast, show];
}

export function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false });
}

/** Press-and-hold button that also fires once immediately on pointer down. */
export function HoldButton({
  label,
  onPress,
  onHold,
  onRelease,
  disabled,
  className,
}: {
  label: string;
  onPress: () => void;
  onHold: () => void;
  onRelease: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const held = useRef(false);

  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    held.current = true;
    onPress();
    onHold();
  };

  const up = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled || !held.current) return;
    held.current = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    onRelease();
  };

  return (
    <button
      className={className}
      disabled={disabled}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onContextMenu={(e) => e.preventDefault()}
      style={{ touchAction: "none" }}
    >
      {label}
    </button>
  );
}
