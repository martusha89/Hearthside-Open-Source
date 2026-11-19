import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

/**
 * Hearthside: weather for agents, from Open-Meteo (free, no key; data CC BY 4.0,
 * "Weather data by Open-Meteo.com"). One small tool: the agent asks for a
 * place, or gets the person's home town from Settings. Includes the pressure
 * trend, which matters to people who get weather migraines.
 */

export const WEATHER_TOOL_NAME = "get_weather";

const CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "heavy freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

type Place = { name: string; latitude: number; longitude: number; country?: string; admin1?: string };

async function findPlace(name: string, fetchImpl: typeof fetch): Promise<Place | null> {
  const params = new URLSearchParams({ name, count: "1", language: "en" });
  const response = await fetchImpl(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`The weather service answered ${response.status}.`);
  const body = (await response.json()) as { results?: Place[] };
  return body.results?.[0] ?? null;
}

type Forecast = {
  current?: { temperature_2m?: number; apparent_temperature?: number; weather_code?: number; wind_speed_10m?: number; relative_humidity_2m?: number; surface_pressure?: number; time?: string };
  daily?: { time?: string[]; weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: number[]; sunrise?: string[]; sunset?: string[] };
  hourly?: { time?: string[]; surface_pressure?: number[] };
};

/** How pressure moves over the next 24 hours, in plain words. */
export function pressureTrend(hourly: Forecast["hourly"], now: string | undefined): string | null {
  const times = hourly?.time ?? [];
  const values = hourly?.surface_pressure ?? [];
  if (values.length < 2) return null;
  const start = Math.max(0, now ? times.findIndex((time) => time >= now.slice(0, 13)) : 0);
  const window = values.slice(start, start + 25);
  if (window.length < 2) return null;
  const change = window[window.length - 1]! - window[0]!;
  const min = Math.min(...window);
  const max = Math.max(...window);
  const words = Math.abs(change) < 3 ? "steady" : change < 0 ? (change <= -6 ? "falling fast" : "falling") : change >= 6 ? "rising fast" : "rising";
  return `${words} over the next 24 hours (${window[0]!.toFixed(0)} → ${window[window.length - 1]!.toFixed(0)} hPa, range ${min.toFixed(0)}–${max.toFixed(0)})`;
}

export async function weatherReport(place: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const found = await findPlace(place, fetchImpl);
  if (!found) return `Couldn't find a place called "${place}".`;
  const params = new URLSearchParams({
    latitude: String(found.latitude),
    longitude: String(found.longitude),
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,surface_pressure",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
    hourly: "surface_pressure",
    timezone: "auto",
    forecast_days: "3",
  });
  const response = await fetchImpl(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`The weather service answered ${response.status}.`);
  const data = (await response.json()) as Forecast;
  const where = [found.name, found.admin1, found.country].filter(Boolean).join(", ");
  const current = data.current ?? {};
  const lines = [`Weather for ${where}:`];
  if (current.temperature_2m !== undefined) {
    lines.push(
      `Now: ${CODES[current.weather_code ?? -1] ?? "unknown"}, ${current.temperature_2m}°C (feels like ${current.apparent_temperature ?? current.temperature_2m}°C), wind ${current.wind_speed_10m ?? "?"} km/h, humidity ${current.relative_humidity_2m ?? "?"}%, pressure ${current.surface_pressure?.toFixed(0) ?? "?"} hPa.`,
    );
  }
  const trend = pressureTrend(data.hourly, current.time);
  if (trend) lines.push(`Pressure: ${trend}.`);
  const daily = data.daily ?? {};
  (daily.time ?? []).forEach((day, index) => {
    const label = index === 0 ? "Today" : index === 1 ? "Tomorrow" : day;
    lines.push(
      `${label}: ${CODES[daily.weather_code?.[index] ?? -1] ?? "unknown"}, ${daily.temperature_2m_min?.[index]}–${daily.temperature_2m_max?.[index]}°C, ${daily.precipitation_probability_max?.[index] ?? 0}% chance of rain, sunrise ${daily.sunrise?.[index]?.slice(11) ?? "?"}, sunset ${daily.sunset?.[index]?.slice(11) ?? "?"}.`,
    );
  });
  lines.push("Weather data by Open-Meteo.com");
  return lines.join("\n");
}

export function createWeatherTool(options: { home: () => string }): AnyAgentTool {
  return {
    name: WEATHER_TOOL_NAME,
    label: "Check the weather",
    description:
      "Check the weather and the next days' forecast for a place, including air pressure and whether it's rising or falling. Leave the place out for the user's home town.",
    parameters: {
      type: "object",
      properties: { place: { type: "string", description: "A town or city, e.g. 'Edinburgh'. Leave out for the user's home town." } },
    },
    execute: async (_toolCallId, args) => {
      const place = String((args as { place?: unknown })?.place ?? "").trim() || options.home().trim();
      if (!place) {
        return { content: [{ type: "text", text: "Which place? The user hasn't set a home town (Settings → General), so ask them or name a town." }], isError: true };
      }
      try {
        return { content: [{ type: "text", text: await weatherReport(place.slice(0, 100)) }] };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}
