import { useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

const inputClass =
  'w-full min-w-0 rounded-input border border-input bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-destructive';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input {...props} className={cn(inputClass, className)} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      {...props}
      className={cn(inputClass, 'min-h-28 resize-y', className)}
    />
  );
}

type FieldControl = Pick<
  ComponentProps<'input'>,
  'id' | 'aria-describedby' | 'aria-invalid' | 'aria-required' | 'required'
>;

/** Render prop keeps label/error relationships intact for input, textarea or select. */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (control: FieldControl) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const description = [hint && `${id}-hint`, error && `${id}-error`]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cn('space-y-2', className)}>
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
        {required && (
          <span className="ml-1 text-destructive" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children({
        id,
        'aria-describedby': description || undefined,
        'aria-invalid': Boolean(error),
        'aria-required': required,
        required,
      })}
      {hint && (
        <p
          id={`${id}-hint`}
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {hint}
        </p>
      )}
      {error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="text-xs leading-relaxed text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}
