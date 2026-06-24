export function chooseProjectId(projects, currentProjectId, preferredProjectId = "") {
  if (preferredProjectId && projects.some((project) => project.id === preferredProjectId)) {
    return preferredProjectId;
  }
  if (currentProjectId && projects.some((project) => project.id === currentProjectId)) {
    return currentProjectId;
  }
  return projects[0]?.id || "";
}

export function matchingProjectState(projectState, projectId) {
  if (!projectState || !projectId || projectState.project?.id !== projectId) {
    return null;
  }
  return projectState;
}
