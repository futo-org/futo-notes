import type { PlatformFS } from './types';

/** Browser development storage for non-note platform services. */
export const webFS: PlatformFS = {
  async readAppData(_path: string): Promise<string | null> {
    return null;
  },
  async writeAppData(_path: string, _content: string): Promise<void> {},
  async deleteAppData(_path: string): Promise<void> {},
  async listAppData(_dir: string): Promise<string[]> {
    return [];
  },
  async listDirFiles() {
    return [];
  },
  async deleteFile(_filename: string): Promise<void> {},
  async getImageUrl(_filename: string): Promise<string> {
    throw new Error('Image URLs not available in web mode');
  },
  async getAppVersion(): Promise<string> {
    return '0.0.0-web';
  },
  async writeClipboardText(text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
  },
};
