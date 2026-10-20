import { afterEach, expect, it, vi } from 'vitest';
import { observeFomoResponses } from '../src/shared/response-observer';

const nativeJson = Response.prototype.json;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; Response.prototype.json = nativeJson; });
function response(url: string, body = '{"success":true}', status = 200) {
  const result = new Response(body, { status });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

it('observes only successful FOMO API JSON that the website actually consumes', async () => {
  const capture = vi.fn(); cleanup = observeFomoResponses(capture);
  const url = 'https://prod-api.fomo.family/v2/users';
  const result = response(url);
  expect(capture).not.toHaveBeenCalled();
  expect(await result.json()).toEqual({ success: true });
  expect(result.bodyUsed).toBe(true);
  expect(capture).toHaveBeenCalledExactlyOnceWith(new URL(url), { success: true });
  await expect(result.json()).rejects.toThrow();
});

it('does not consume or inspect unrelated API, asset or error responses', async () => {
  const capture = vi.fn(); cleanup = observeFomoResponses(capture);
  for (const url of ['https://example.org/events', 'https://prod-api.fomo.family/other/balances', 'https://fomo.family/config']) {
    expect(await response(url).json()).toEqual({ success: true });
  }
  await response('https://prod-api.fomo.family/config', '{"success":true}', 403).json();
  expect(capture).not.toHaveBeenCalled();
});

it('preserves the native JSON promise and original rejection without observer rejections', async () => {
  const error = new SyntaxError('Invalid JSON');
  const promise = Promise.reject(error);
  Response.prototype.json = vi.fn(() => promise);
  const capture = vi.fn(); cleanup = observeFomoResponses(capture);
  const actual = response('https://prod-api.fomo.family/config').json();
  expect(actual).toBe(promise);
  await expect(actual).rejects.toBe(error);
  expect(capture).not.toHaveBeenCalled();
});

it('isolates observer failures and restores the original JSON reader on cleanup', async () => {
  const capture = vi.fn(() => { throw new Error('observer failed'); });
  cleanup = observeFomoResponses(capture);
  expect(await response('https://prod-api.fomo.family/config').json()).toEqual({ success: true });
  await Promise.resolve();
  cleanup();
  expect(Response.prototype.json).toBe(nativeJson);
});
