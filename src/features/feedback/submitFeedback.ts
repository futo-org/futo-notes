import { getAppVersion } from '$features/system/crashHandler';
import { crashlogBaseUrl } from '$features/system/crashlogEndpoint';
import { platformName } from '$lib/platform';

export interface FeedbackDraft {
  message: string;
  images: ArrayBuffer[];
}

export function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let index = 0; index < view.length; index++) binary += String.fromCharCode(view[index]);
  return btoa(binary);
}

export async function submitFeedback(draft: FeedbackDraft): Promise<void> {
  const response = await fetch(`${crashlogBaseUrl()}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: draft.message,
      app_version: getAppVersion(),
      platform: platformName,
      device_info: `${navigator.userAgent} | ${screen.width}x${screen.height}`,
      images: draft.images.map((image) => ({ data: toBase64(image) })),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
}
