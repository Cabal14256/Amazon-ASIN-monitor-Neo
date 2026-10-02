import { Link } from '@tanstack/react-router';
import { Search, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { AccessPolicy } from '../auth/access';
import { cn } from '../lib/utils';
import { workspaceNavigation } from './app-shell-navigation';

export function CommandNavigation({
  open,
  access,
  onClose,
  returnFocus,
}: {
  open: boolean;
  access: AccessPolicy;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const options = useRef(new Map<string, HTMLAnchorElement>());
  const [query, setQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const items = workspaceNavigation(access).flatMap((section) =>
    section.items.filter(
      (item) =>
        item.available &&
        tokens.every((token) =>
          `${item.label} ${item.path}`.toLocaleLowerCase().includes(token),
        ),
    ),
  );
  const selected = items.find((item) => item.path === selectedPath) ?? items[0];
  const optionId = (path: string) => `${id}-option-${path.slice(1)}`;

  useLayoutEffect(() => {
    if (!open) {
      // Restore after React has removed the shell's inert attribute. Layout
      // cleanup runs before that mutation, when the original control is inert.
      const previous = returnFocus.current;
      if (previous?.isConnected && !previous.closest('[inert]'))
        previous.focus();
      return;
    }
    if (!dialog.current) return;
    const element = dialog.current;
    const previousOverflow = document.body.style.overflow;
    setQuery('');
    setSelectedPath(null);
    element.showModal();
    document.body.style.overflow = 'hidden';
    input.current?.focus();
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [open, returnFocus]);

  useEffect(() => {
    if (open && selected)
      options.current
        .get(selected.path)
        ?.scrollIntoView?.({ block: 'nearest' });
  }, [open, selected]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-hint`}
      className="fixed inset-0 m-auto w-[calc(100%_-_2rem)] max-w-xl rounded-card border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-ink/50"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (
          event.key === 'Escape' ||
          ((event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            event.key.toLowerCase() === 'k')
        ) {
          event.preventDefault();
          if (event.key === 'Escape' || !event.repeat) onClose();
          return;
        }
        if (event.key === 'Tab') {
          const first = closeButton.current;
          const last =
            (selected && options.current.get(selected.path)) || input.current;
          if (!event.shiftKey && event.target === last && first) {
            event.preventDefault();
            first.focus();
          } else if (event.shiftKey && event.target === first && last) {
            event.preventDefault();
            last.focus();
          }
          return;
        }
        if (
          (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
          items.length
        ) {
          event.preventDefault();
          const current = items.findIndex(
            (item) => item.path === selected?.path,
          );
          const next =
            items[
              (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
                items.length
            ];
          setSelectedPath(next.path);
          if (event.target !== input.current)
            options.current.get(next.path)?.focus();
        } else if (event.key === 'Enter' && event.target === input.current) {
          event.preventDefault();
          if (selected) options.current.get(selected.path)?.click();
        }
      }}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 id={`${id}-title`} className="font-semibold">
          跳转到页面
        </h2>
        <button
          ref={closeButton}
          type="button"
          aria-label="关闭命令面板"
          onClick={onClose}
          className="rounded-control p-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="flex items-center gap-3 px-5 py-4">
        <Search
          aria-hidden="true"
          className="size-5 shrink-0 text-muted-foreground"
        />
        <input
          ref={input}
          type="search"
          role="combobox"
          aria-label="搜索页面名称或路径"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={`${id}-results`}
          aria-activedescendant={selected ? optionId(selected.path) : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setSelectedPath(null);
          }}
          placeholder="输入页面名称或路径…"
          className="min-w-0 flex-1 rounded-control border border-input bg-card px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
        />
      </div>
      <div
        id={`${id}-results`}
        role="listbox"
        aria-label="可访问的页面"
        className="max-h-[50dvh] overflow-y-auto px-3 pb-3"
      >
        {items.map((item) => {
          const Icon = item.icon;
          const active = item.path === selected?.path;
          return (
            <Link
              key={item.path}
              ref={(element) => {
                if (element) options.current.set(item.path, element);
                else options.current.delete(item.path);
              }}
              to={item.path}
              id={optionId(item.path)}
              role="option"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onFocus={() => setSelectedPath(item.path)}
              onClick={onClose}
              className={cn(
                'flex min-h-12 items-center gap-3 rounded-control px-3 py-2 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
                active && 'bg-muted',
              )}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              <span className="flex-1 font-medium">{item.label}</span>
              <span className="neo-mono text-xs text-muted-foreground">
                {item.path}
              </span>
            </Link>
          );
        })}
      </div>
      {!items.length && (
        <p role="status" className="px-5 pb-5 text-sm text-muted-foreground">
          没有匹配的可访问页面，请换一个名称或路径。
        </p>
      )}
      <p
        id={`${id}-hint`}
        className="border-t border-border px-5 py-3 text-xs text-muted-foreground"
      >
        ↑ ↓ 选择 · Enter 打开 · Tab 切换控件 · Esc 关闭
      </p>
    </dialog>
  );
}
