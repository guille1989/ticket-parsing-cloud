import { buildAgentHabits } from "../../../src/travis/detectors/habits";
import { buildHistory, NOW } from "./fixtures";

test("calcula la fracción de días y los tickets promedio por hora, y deja en cero las horas sin actividad", () => {
  const habits = buildAgentHabits(buildHistory({ agentIds: ["a1"] }), NOW, "UTC");

  expect(habits.a1.activeDays).toBe(28);
  expect(habits.a1.dayShare[10]).toBe(1);
  expect(habits.a1.avgTickets[10]).toBe(5);
  expect(habits.a1.dayShare[3]).toBe(0);
  expect(habits.a1.avgTickets[3]).toBe(0);
});

test("una hora con actividad solo algunos días tiene fracción parcial", () => {
  const history = buildHistory({ hours: [10] });
  // Las 18:00 solo se capturan en 7 de los 28 días.
  history.push(...buildHistory({ hours: [18], days: 7 }));

  expect(buildAgentHabits(history, NOW, "UTC").a1.dayShare[18]).toBe(0.25);
});

test("hoy no cuenta (está a medias) ni los días fuera de la ventana de 28", () => {
  const history = [...buildHistory({ lastDay: "2026-11-04", days: 3 }), ...buildHistory({ lastDay: "2026-09-01", days: 20 })];
  expect(buildAgentHabits(history, NOW, "UTC")).toEqual({});
});

test("un robot con menos de 5 días activos todavía no tiene hábito", () => {
  expect(buildAgentHabits(buildHistory({ days: 4 }), NOW, "UTC")).toEqual({});
});
