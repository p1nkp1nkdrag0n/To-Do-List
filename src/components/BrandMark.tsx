import { Check } from "lucide-react";

interface BrandMarkProps {
  auth?: boolean;
  compact?: boolean;
}

export function BrandMark({ auth = false, compact = false }: BrandMarkProps) {
  return (
    <span className={`brand-lockup ${auth ? "brand-lockup-auth" : ""} ${compact ? "brand-lockup-compact" : ""}`}>
      {!auth ? (
        <span className="brand-logo" aria-hidden="true">
          <Check size={15} strokeWidth={3.2} />
        </span>
      ) : null}
      <span className="brand-wordmark">
        <span>TO DO</span> <strong>LIST</strong>
      </span>
    </span>
  );
}
