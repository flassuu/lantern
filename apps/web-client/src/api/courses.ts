import { apiFetch, ApiError, getToken } from './client'
import { normalizeCourse } from './normalize'
import type { CourseDetails, CourseInput, CourseSummary, Material } from './types'

/** Teacher/admin: own courses (admin sees all). */
export async function listCourses(): Promise<CourseSummary[]> {
  const result = await apiFetch<{ courses: CourseSummary[] }>('/api/courses')
  return result.courses.map(normalizeCourse)
}

export async function getCourse(id: string): Promise<CourseDetails> {
  return normalizeCourse(await apiFetch<CourseDetails>(`/api/courses/${id}`))
}

export async function createCourse(input: CourseInput): Promise<CourseDetails> {
  return normalizeCourse(
    await apiFetch<CourseDetails>('/api/courses', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  )
}

export async function updateCourse(id: string, input: CourseInput): Promise<CourseDetails> {
  return normalizeCourse(
    await apiFetch<CourseDetails>(`/api/courses/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  )
}

export async function deleteCourse(id: string): Promise<void> {
  await apiFetch<void>(`/api/courses/${id}`, { method: 'DELETE' })
}

export async function enrollStudent(courseId: string, username: string): Promise<CourseDetails> {
  return normalizeCourse(
    await apiFetch<CourseDetails>(`/api/courses/${courseId}/enrollments`, {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),
  )
}

export async function unenrollStudent(courseId: string, userId: string): Promise<void> {
  await apiFetch<void>(`/api/courses/${courseId}/enrollments/${userId}`, { method: 'DELETE' })
}

export async function attachTest(courseId: string, testId: string): Promise<CourseDetails> {
  return normalizeCourse(
    await apiFetch<CourseDetails>(`/api/courses/${courseId}/tests`, {
      method: 'POST',
      body: JSON.stringify({ testId }),
    }),
  )
}

export async function detachTest(courseId: string, testId: string): Promise<void> {
  await apiFetch<void>(`/api/courses/${courseId}/tests/${testId}`, { method: 'DELETE' })
}

/** Uploads a file as raw octet-stream bytes (no multipart). */
export async function uploadMaterial(courseId: string, file: File): Promise<Material> {
  const name = encodeURIComponent(file.name)
  return apiFetch<Material>(`/api/courses/${courseId}/materials?name=${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  })
}

/** Downloads a material file through an authenticated fetch + object URL. */
export async function downloadMaterial(courseId: string, materialId: string, title: string): Promise<void> {
  const token = getToken()
  const res = await fetch(`/api/courses/${courseId}/materials/${materialId}/file`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new ApiError(res.status, 'ERROR', 'download failed')
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = title
  anchor.click()
  URL.revokeObjectURL(url)
}