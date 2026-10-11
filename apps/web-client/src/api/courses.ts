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

// ------------------------------------------------------------------- topics

/** A lesson: an ordered heading a test or a material can be filed under. */
export interface CourseTopic {
  id: string
  title: string
  position: number
}

export async function createTopic(courseId: string, title: string): Promise<CourseTopic> {
  const result = await apiFetch<{ topic: CourseTopic }>(`/api/courses/${courseId}/topics`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
  return result.topic
}

export async function renameTopic(
  courseId: string,
  topicId: string,
  title: string,
): Promise<CourseTopic> {
  const result = await apiFetch<{ topic: CourseTopic }>(
    `/api/courses/${courseId}/topics/${topicId}`,
    { method: 'PATCH', body: JSON.stringify({ title }) },
  )
  return result.topic
}

/** What was filed under it is left behind with no lesson - the server says so. */
export async function deleteTopic(courseId: string, topicId: string): Promise<void> {
  await apiFetch<void>(`/api/courses/${courseId}/topics/${topicId}`, { method: 'DELETE' })
}

export async function reorderTopics(
  courseId: string,
  ids: string[],
): Promise<CourseTopic[]> {
  const result = await apiFetch<{ topics: CourseTopic[] }>(
    `/api/courses/${courseId}/topics/order`,
    { method: 'PUT', body: JSON.stringify({ ids }) },
  )
  return result.topics
}

/** Files a test under a lesson, or `null` takes it out of every lesson. */
export async function setTestTopic(
  courseId: string,
  testId: string,
  topicId: string | null,
): Promise<void> {
  await apiFetch<unknown>(`/api/courses/${courseId}/tests/${testId}`, {
    method: 'PATCH',
    body: JSON.stringify({ topicId }),
  })
}

export async function setMaterialTopic(
  courseId: string,
  materialId: string,
  topicId: string | null,
): Promise<void> {
  await apiFetch<unknown>(`/api/courses/${courseId}/materials/${materialId}`, {
    method: 'PATCH',
    body: JSON.stringify({ topicId }),
  })
}

// ----------------------------------------------------------- announcements

export async function createAnnouncement(
  courseId: string,
  body: string,
  materialId: string | null,
): Promise<void> {
  await apiFetch<unknown>(`/api/courses/${courseId}/announcements`, {
    method: 'POST',
    body: JSON.stringify({ body, materialId }),
  })
}

export async function deleteAnnouncement(
  courseId: string,
  announcementId: string,
): Promise<void> {
  await apiFetch<void>(`/api/courses/${courseId}/announcements/${announcementId}`, {
    method: 'DELETE',
  })
}
