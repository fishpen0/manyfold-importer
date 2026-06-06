/**
 * Downloads a file from a URL and returns a Blob.
 * For Makerworld, the user's browser session cookies are automatically
 * included because the background script shares the browser's cookie jar
 * for cross-origin fetches when credentials: "include" is set.
 */
export async function downloadFile(url, filename) {
  const res = await fetch(url, {
    credentials: "include",
  });

  if (!res.ok) {
    throw new Error(`Download failed for ${filename} (${res.status}): ${url}`);
  }

  const blob = await res.blob();
  if (blob.size === 0) {
    throw new Error(`Empty file downloaded for ${filename}`);
  }

  return blob;
}
