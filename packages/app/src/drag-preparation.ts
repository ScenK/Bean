export function createDragPreparationGate(): { begin: () => boolean; end: () => void } {
  let pending = false;
  return {
    begin: () => {
      if (pending) return false;
      pending = true;
      return true;
    },
    end: () => { pending = false; },
  };
}
