export function navigate(path: string) {
  window.location.hash = `#${path}`;
}
