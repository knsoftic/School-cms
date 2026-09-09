'use client';

/**
 * Tabs — URL-backed (`?tab=`), ARIA tab pattern. Used by Fees, Finance, Library.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

export interface TabDef {
  key: string;
  label: string;
}

export function useActiveTab(tabs: TabDef[]): [string, (key: string) => void] {
  const router = useRouter();
  const params = useSearchParams();

  const requested = params.get('tab');
  const active = tabs.some((tab) => tab.key === requested) ? (requested as string) : tabs[0].key;

  const setActive = useCallback(
    (key: string) => {
      const next = new URLSearchParams(params.toString());
      next.set('tab', key);
      for (const key2 of ['page', 'q', 'status']) next.delete(key2);
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [params, router]
  );

  return [active, setActive];
}

export function Tabs({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (key: string) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="mb-5 flex flex-wrap gap-1 border-b border-border"
    >
      {tabs.map((tab) => {
        const current = tab.key === active;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={`tab-${tab.key}`}
            aria-selected={current}
            aria-controls={`panel-${tab.key}`}
            onClick={() => onChange(tab.key)}
            className={`-mb-px border-b-2 px-3.5 py-2.5 text-sm transition-colors ${
              current
                ? 'border-teal font-semibold text-teal-deep'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ tabKey, children }: { tabKey: string; children: React.ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${tabKey}`} aria-labelledby={`tab-${tabKey}`}>
      {children}
    </div>
  );
}
