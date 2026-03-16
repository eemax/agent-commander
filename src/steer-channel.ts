export type SteerChannel = {
  push(message: string): void;
  drain(): string[];
};

export function createSteerChannel(): SteerChannel {
  const buffer: string[] = [];
  return {
    push(message: string) {
      buffer.push(message);
    },
    drain() {
      const items = [...buffer];
      buffer.length = 0;
      return items;
    }
  };
}
