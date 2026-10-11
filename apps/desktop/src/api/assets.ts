import { apiFetch, fetchBlob } from './client'

/** A picture a question points at. */
export interface Asset {
  id: string
  ownerId: string
  title: string
  mimeType: string
  sizeBytes: number
  createdAt: string
}

/**
 * Uploads an image and returns what the server stored.
 *
 * The bytes are the request body and the name rides in the query, which is what
 * the server takes: a file picker has no other way to hand over a picture
 * without a multipart parser, and the picture is the only thing in a question
 * that does not fit in a JSON string.
 */
export async function uploadAsset(file: File): Promise<Asset> {
  const res = await apiFetch<{ asset: Asset }>(
    `/api/assets?name=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    },
  )
  return res.asset
}

export async function listAssets(): Promise<Asset[]> {
  const res = await apiFetch<{ assets: Asset[] }>('/api/assets')
  return res.assets
}

/** Takes the image off the server; nothing referencing it will ever load again. */
export async function deleteAsset(assetId: string): Promise<void> {
  await apiFetch<void>(`/api/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' })
}

/**
 * The image's bytes, as a URL an <img> can use.
 *
 * An <img src> cannot be used directly: the API authenticates with an
 * Authorization header rather than a cookie, so a plain URL would be turned away
 * at the door. The token goes in the fetch, and what comes back is held as an
 * object URL - which also means the caller owns it and must revoke it.
 */
export async function fetchAssetObjectUrl(assetId: string): Promise<string> {
  const blob = await fetchBlob(`/api/assets/${encodeURIComponent(assetId)}`)
  return URL.createObjectURL(blob)
}
