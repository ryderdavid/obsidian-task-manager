import {
  addParentId,
  extractId,
  extractParentId,
  isParentTask,
  isSubtask,
  removeParentId
} from '../utils/task-utils';

// ============================================================================
// PARENT-CHILD LINKER MODULE
// ============================================================================

export function linkContent(content, settings) {
  const lines = content.split('\n');
  const result = [];

  let currentParentId = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    const isParent = isParentTask(line);
    const isChild = isSubtask(line);

    if (isParent) {
      currentParentId = extractId(line);

      // Remove any parent field from top-level tasks
      if (extractParentId(line)) {
        line = removeParentId(line);
      }

      result.push(line);

    } else if (isChild) {
      const existingParentId = extractParentId(line);

      // Only add parent link if subtask doesn't have one and parent has an ID
      if (!existingParentId && currentParentId) {
        line = addParentId(line, currentParentId);
      }

      result.push(line);

    } else {
      // Reset parent tracking on headers
      if (/^#/.test(line)) {
        currentParentId = null;
      }
      result.push(line);
    }
  }

  return result.join('\n');
}
