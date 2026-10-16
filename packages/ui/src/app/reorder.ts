import { useState, type DragEvent } from 'react';

/** The order after dragging `moved` onto `target`: it lands after a target to its right, before one to its left. */
export function moveItem(ids: readonly string[], moved: string, target: string): readonly string[] {
  const from = ids.indexOf(moved);
  const to = ids.indexOf(target);
  if (from === -1 || to === -1 || from === to) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Drag-and-drop reordering for a row of items (tabs, project cards). */
export function useDragReorder(ids: readonly string[], commit: (ids: readonly string[]) => void) {
  const [dragging, setDragging] = useState<string>();
  const itemProps = (id: string) => ({
    draggable: true,
    onDragStart: (event: DragEvent) => {
      setDragging(id);
      event.dataTransfer.effectAllowed = 'move';
    },
    onDragOver: (event: DragEvent) => {
      if (dragging !== undefined && dragging !== id) event.preventDefault();
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      if (dragging !== undefined) {
        const next = moveItem(ids, dragging, id);
        if (next !== ids) commit(next);
      }
      setDragging(undefined);
    },
    onDragEnd: () => setDragging(undefined),
  });
  return { dragging, itemProps };
}
