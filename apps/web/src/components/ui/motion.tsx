import {
  animate,
  domAnimation,
  LazyMotion,
  m,
  MotionConfig,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'motion/react';
import { useEffect, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

const numberFormat = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 0,
});

export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig
        reducedMotion="user"
        transition={{ type: 'spring', duration: 0.35, bounce: 0.12 }}
      >
        <>{children}</>
      </MotionConfig>
    </LazyMotion>
  );
}

/** First-mount entrances only, with capped staggering for long lists. */
export function Entrance({
  children,
  index = 0,
  className,
}: {
  children: ReactNode;
  index?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const delay =
    Math.min(5, Math.max(0, Number.isFinite(index) ? index : 0)) * 0.04;
  return (
    <m.div
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: reduced ? 0 : 0.2,
        delay: reduced ? 0 : delay,
        ease: 'easeOut',
      }}
      className={className}
    >
      {children}
    </m.div>
  );
}

/** Screen readers receive the settled value, never each intermediate frame. */
export function AnimatedNumber({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const finite = Number.isFinite(value);
  const target = finite ? value : 0;
  const count = useMotionValue(target);
  const formatted = useTransform(count, (latest) =>
    numberFormat.format(latest),
  );
  useEffect(() => {
    if (reduced || !finite) {
      count.jump(target);
      return;
    }
    const controls = animate(count, target, { duration: 0.7, ease: 'easeOut' });
    return () => controls.stop();
  }, [count, finite, reduced, target]);
  return (
    <span className={cn('neo-mono', className)}>
      <span className="sr-only">
        {finite ? numberFormat.format(value) : '未知'}
      </span>
      <m.span aria-hidden="true">{finite ? formatted : '—'}</m.span>
    </span>
  );
}

/** Pass a new revision for each realtime event; omit before the first event. */
export function UpdatePulse({
  revision,
  children,
  className,
}: {
  revision?: string | number;
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <div className={cn('relative isolate', className)}>
      {!reduced && revision !== undefined && (
        <m.div
          key={revision}
          aria-hidden="true"
          initial={{ opacity: 0.65 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 0.8 }}
          className="pointer-events-none absolute inset-0 -z-10 rounded-[inherit] bg-signal-soft"
        />
      )}
      {children}
    </div>
  );
}

export function SuccessMark() {
  const reduced = useReducedMotion();
  return (
    <svg
      aria-hidden="true"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      className="text-status-success"
    >
      <m.path
        d="m5 12 4 4L19 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: reduced ? 1 : 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: reduced ? 0 : 0.4 }}
      />
    </svg>
  );
}
