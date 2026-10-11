import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { fetchAssetObjectUrl } from '../api/assets'

/**
 * The picture behind an asset id, as a URL an <img> can use.
 *
 * The fetch is the point: the API authenticates with a header, not a cookie, so
 * an <img src="/api/assets/..."> would be turned away at the door. What comes
 * back is held as an object URL instead, which makes this the owner of that URL
 * - it is revoked when the id changes and when the view goes away, because a
 * blob URL nobody revokes is a question diagram kept in memory for the life of
 * the tab.
 *
 * A failed load is not an error to shout about: an id the server no longer holds
 * (a deleted image, a test imported from another machine) should leave a gap
 * where the picture was, not an error card in the middle of a paper.
 */
export interface AssetImage {
  url: Ref<string | null>
  loading: Ref<boolean>
}

export function useAssetImage(assetId: Ref<string | null>): AssetImage {
  const url = ref<string | null>(null)
  const loading = ref(false)
  let held: string | null = null
  let wanted = 0

  function release(): void {
    if (held !== null) URL.revokeObjectURL(held)
    held = null
    url.value = null
  }

  watch(
    assetId,
    async (id) => {
      // The token that counts is the one issued after the last change: a slow
      // fetch for a picture nobody is waiting for any more must not win.
      const mine = (wanted += 1)
      release()
      if (id === null || id === '') return
      loading.value = true
      try {
        const objectUrl = await fetchAssetObjectUrl(id)
        if (mine !== wanted) {
          URL.revokeObjectURL(objectUrl)
          return
        }
        held = objectUrl
        url.value = objectUrl
      } catch {
        // Nothing to show; the gap is the honest answer.
      } finally {
        if (mine === wanted) loading.value = false
      }
    },
    { immediate: true },
  )

  onScopeDispose(release)

  return { url, loading }
}
