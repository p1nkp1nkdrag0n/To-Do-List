import { useEffect, useState } from "react";

export function useSessionDraft<Value>(key: string, initialValue: Value) {
  const [value, setValue] = useState<Value>(() => {
    const stored = sessionStorage.getItem(key);
    if (stored === null) return initialValue;
    try {
      return JSON.parse(stored) as Value;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    const stored = sessionStorage.getItem(key);
    if (stored === null) setValue(initialValue);
    else {
      try {
        setValue(JSON.parse(stored) as Value);
      } catch {
        setValue(initialValue);
      }
    }
    // The key defines a new form identity; callers intentionally provide a fresh baseline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    sessionStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  const clear = () => sessionStorage.removeItem(key);
  return [value, setValue, clear] as const;
}
