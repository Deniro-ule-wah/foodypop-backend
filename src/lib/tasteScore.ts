import { prisma } from "./prisma";

// Simple v0 scoring: weight "positive" gestures higher, normalize 0-100.
// This is intentionally simple — the real "AI understands relationships"
// food graph work comes later, once there's enough gesture volume to learn from.
const POSITIVE_WEIGHT: Record<string, number> = {
  DELICIOUS: 3,
  REFRESHING: 2,
  CRISPY: 2,
  RICH: 2,
  FILLING: 1,
  SWEET: 1,
  SPICY: 1,
  SALTY: 1,
  SOUR: 0.5,
  BITTER: 0.5,
};

export async function recomputeTasteScore(dishId: string): Promise<number> {
  const gestures = await prisma.tasteGesture.findMany({ where: { dishId } });

  if (gestures.length === 0) {
    await prisma.dish.update({ where: { id: dishId }, data: { tasteScore: 0 } });
    return 0;
  }

  const totalWeight = gestures.reduce(
    (sum: number, g: { type: string }) => sum + (POSITIVE_WEIGHT[g.type] ?? 1),
    0
  );
  const maxPossible = gestures.length * 3; // DELICIOUS is the max weight
  const score = Math.min(100, Math.round((totalWeight / maxPossible) * 100));

  await prisma.dish.update({ where: { id: dishId }, data: { tasteScore: score } });
  return score;
}
