import type { ReactNode } from 'react';

/**
 * 全站 chrome 图标：统一 stroke 线性集（24 格 viewBox，strokeWidth 2，currentColor）。
 * 蓝皮书基调要的是钢笔线稿感，不是彩色表情符——一个 SVG 各状态随文字自动换色。
 * 仅做界面操作提示用（aria-hidden），语义一律由相邻文字或 title 承担。
 */
const ICONS = {
  pen: <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />,
  workflow: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <path d="M10 6.5h3.5a2 2 0 0 1 2 2V14" />
    </>
  ),
  play: <path d="M7 5l12 7-12 7z" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  sliders: (
    <>
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="14" cy="18" r="2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.8 1.8M17.2 17.2L19 19M19 5l-1.8 1.8M6.8 17.2L5 19" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4 7 7 0 0 0 20 14.5z" />,
  save: <path d="M5 3h11l3 3v15H5zM8 3v5h8V3M8 21v-7h8v7" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M4.5 12.5l5 5L19.5 7" />,
  download: <path d="M12 3v11M7 10l5 5 5-5M4 20h16" />,
  shelf: (
    <>
      <path d="M3 4h18v4H3z" />
      <path d="M5 8v12h14V8" />
      <path d="M10 12h4" />
    </>
  ),
  box: (
    <>
      <path d="M4 7l8-4 8 4v10l-8 4-8-4z" />
      <path d="M4 7l8 4 8-4M12 11v10" />
    </>
  ),
  resume: <path d="M4 18v-6a3 3 0 0 1 3-3h11M14 5l4 4-4 4" />,
  undo: <path d="M4 10l3.5-3.5M4 10l3.5 3.5M4 10h10a5.5 5.5 0 0 1 0 11H9" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />,
  external: <path d="M7 17L17 7M9 7h8v8" />,
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  bookmark: <path d="M6 3h12v18l-6-4.5L6 21z" />,
  alert: <path d="M12 3.5L21.5 20h-19zM12 9.5v5M12 17.4v.1" />,
  pr: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M13 6h2.5A2.5 2.5 0 0 1 18 8.5V15.5" />
    </>
  ),
  doc: (
    <>
      <path d="M6 2.5h8l4 4V21.5H6zM14 2.5V6.5h4" />
      <path d="M9 11h6M9 15h6" />
    </>
  ),
  book: (
    <>
      <path d="M12 6.5C10.5 5 8 4.5 3.5 5.5V19c4.5-1 7-.5 8.5 1 1.5-1.5 4-2 8.5-1V5.5c-4.5-1-7-.5-8.5 1z" />
      <path d="M12 6.5V20" />
    </>
  ),
  pause: <path d="M9.5 5v14M14.5 5v14" />,
  bell: (
    <>
      <path d="M6 9.5a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13.5 6 9.5z" />
      <path d="M10.3 18.6a1.9 1.9 0 0 0 3.4 0" />
    </>
  ),
  chevron: <path d="M8 10l4 4 4-4" />,
  radio: (
    <>
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 19.1a10 10 0 0 0 0-14.2" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.7 3.2 2.7 14.8 0 18M12 3c-2.7 3.2-2.7 14.8 0 18" />
    </>
  ),
  code: <path d="M8.5 6L3 12l5.5 6M15.5 6L21 12l-5.5 6" />,
  cpu: (
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
      <path d="M9.5 2.5v4M14.5 2.5v4M9.5 17.5v4M14.5 17.5v4M2.5 9.5h4M2.5 14.5h4M17.5 9.5h4M17.5 14.5h4" />
    </>
  ),
  send: <path d="M21 3L3 10.5l7 3 3 7L21 3zM10 13.5L21 3" />,
  key: (
    <>
      <circle cx="8" cy="16" r="3.5" />
      <path d="M10.5 13.5L20 4M15.5 8.5L18 11" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M16.2 16.2L21 21" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M20 3.5V8h-4.5" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 14, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`ic${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}
