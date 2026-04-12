<script lang="ts">
  import { listImageFiles, deleteImage, type ImageFileEntry } from '$lib/images';
  import { getImageWebPath } from '$lib/fileSystem';

  let images: ImageFileEntry[] = $state([]);
  let selectedImage: string | null = $state(null);
  let menuOpen = $state(false);
  let loading = $state(true);

  async function loadImages(): Promise<void> {
    loading = true;
    try {
      images = await listImageFiles();
    } catch (e) {
      console.warn('Failed to load images:', e);
      images = [];
    } finally {
      loading = false;
    }
  }

  async function handleDelete(): Promise<void> {
    if (!selectedImage) return;
    const filename = selectedImage;
    try {
      await deleteImage(filename);
      images = images.filter(img => img.filename !== filename);
      selectedImage = null;
      menuOpen = false;
    } catch (e) {
      console.warn('Failed to delete image:', e);
    }
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function getSelectedEntry(): ImageFileEntry | undefined {
    return images.find(img => img.filename === selectedImage);
  }

  $effect(() => {
    loadImages();
  });
</script>

<div class="sidebar-image-view">
  {#if loading}
    <div class="sidebar-image-empty">Loading images...</div>
  {:else if images.length === 0}
    <div class="sidebar-image-empty">No images</div>
  {:else if selectedImage}
    {@const entry = getSelectedEntry()}
    <div class="sidebar-image-detail">
      <div class="sidebar-image-detail-header">
        <button class="sidebar-image-back" aria-label="Back" onclick={() => { selectedImage = null; menuOpen = false; }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <div class="sidebar-image-detail-menu-anchor">
          <button class="sidebar-image-menu-btn" aria-label="Image options" onclick={() => { menuOpen = !menuOpen; }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>
            </svg>
          </button>
          {#if menuOpen}
            <button
              type="button"
              class="sidebar-image-menu-backdrop"
              aria-label="Close image menu"
              onclick={() => { menuOpen = false; }}
            ></button>
            <div class="sidebar-image-menu">
              <button class="danger" onclick={handleDelete}>Delete image</button>
            </div>
          {/if}
        </div>
      </div>
      <div class="sidebar-image-preview">
        {#await getImageWebPath(selectedImage)}
          <div class="sidebar-image-empty">Loading...</div>
        {:then url}
          <img src={url} alt={selectedImage} />
        {:catch}
          <div class="sidebar-image-empty">Failed to load</div>
        {/await}
      </div>
      <div class="sidebar-image-info">
        <div class="sidebar-image-info-name">{selectedImage}</div>
        {#if entry}
          <div class="sidebar-image-info-size">{formatSize(entry.size)}</div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="sidebar-image-grid">
      {#each images as image (image.filename)}
        <button class="sidebar-image-thumb-btn" onclick={() => { selectedImage = image.filename; }}>
          {#await getImageWebPath(image.filename)}
            <div class="sidebar-image-thumb-placeholder"></div>
          {:then url}
            <img class="sidebar-image-thumb" src={url} alt={image.filename} loading="lazy" />
          {:catch}
            <div class="sidebar-image-thumb-placeholder"></div>
          {/await}
          <span class="sidebar-image-thumb-label">{image.filename}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
