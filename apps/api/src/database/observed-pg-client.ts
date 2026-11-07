import { Client } from 'pg';

export type DatabaseOperation =
  | 'SELECT'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'OTHER';
export type DatabaseQueryObserver = (
  operation: DatabaseOperation,
  status: 'success' | 'error',
  seconds: number,
) => void;

/** Observe standard driver invocations, never SQL text/values or server rows.
 * QueryStream/Submittable objects retain the native path without observation. */
export function observedPgClient(
  observe: DatabaseQueryObserver,
  onFailure: () => void,
): typeof Client {
  const nativeQuery = Client.prototype.query;
  let warned = false;
  return class ObservedClient extends Client {
    override query = function (this: Client, ...args: unknown[]): unknown {
      const config = args[0];
      const object =
        config && typeof config === 'object'
          ? (config as Record<string, unknown>)
          : undefined;
      if (typeof object?.submit === 'function')
        return Reflect.apply(nativeQuery, this, args);
      const text =
        typeof config === 'string'
          ? config
          : typeof object?.text === 'string'
          ? object.text
          : '';
      const token = /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i
        .exec(text.slice(0, 64))?.[1]
        .toUpperCase();
      const operation = (token ?? 'OTHER') as DatabaseOperation;
      const started = performance.now();
      let settled = false;
      const finish = (error: unknown) => {
        if (settled) return;
        settled = true;
        try {
          observe(
            operation,
            error ? 'error' : 'success',
            Math.max(0, performance.now() - started) / 1000,
          );
        } catch {
          if (!warned) {
            warned = true;
            try {
              onFailure();
            } catch {
              /* Diagnostics cannot affect SQL. */
            }
          }
        }
      };
      const callbackIndex =
        typeof args[2] === 'function'
          ? 2
          : typeof args[1] === 'function'
          ? 1
          : -1;
      const callback =
        callbackIndex >= 0 ? args[callbackIndex] : object?.callback;
      let restore: (() => void) | undefined;
      if (typeof callback === 'function') {
        const wrapped = function (this: unknown, ...values: unknown[]) {
          finish(values[0]);
          return Reflect.apply(callback, this, values);
        };
        if (callbackIndex >= 0) {
          args[callbackIndex] = wrapped;
          if (object)
            restore = () => {
              // pg normalizes explicit callbacks onto the caller's config.
              // Preserve the original callback rather than the observer wrapper.
              if (object.callback === wrapped) object.callback = callback;
            };
        } else if (object) {
          const descriptor = Object.getOwnPropertyDescriptor(
            object,
            'callback',
          );
          if (descriptor?.writable || descriptor?.set) {
            object.callback = wrapped;
            restore = () => {
              Object.defineProperty(object, 'callback', descriptor);
            };
          } else {
            // A frozen config with an embedded callback is supported by pg.
            // Keep all descriptors, values and prototypes; never mutate it.
            const descriptors = Object.getOwnPropertyDescriptors(object);
            descriptors.callback = {
              value: wrapped,
              configurable: true,
              enumerable: true,
              writable: true,
            };
            args[0] = Object.create(Object.getPrototypeOf(object), descriptors);
          }
        }
      }
      try {
        const value: unknown = Reflect.apply(nativeQuery, this, args);
        if (
          typeof callback !== 'function' &&
          value &&
          typeof (value as Promise<unknown>).then === 'function'
        )
          return (value as Promise<unknown>).then(
            (result) => {
              finish(null);
              return result;
            },
            (error: unknown) => {
              finish(error);
              throw error;
            },
          );
        return value;
      } catch (error) {
        finish(error);
        throw error;
      } finally {
        restore?.();
      }
    } as Client['query'];
  };
}
