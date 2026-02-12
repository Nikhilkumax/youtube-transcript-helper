import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  name: { simpleText?: string; runs?: Array<{ text: string }> };
  kind?: string;
}

interface TranscriptEntry {
  text: string;
  start: number;
  duration: number;
}

function parseXmlCaptions(xml: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const regex = /<text start="([^"]*)" dur="([^"]*)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const text = match[3]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/\n/g, ' ')
      .trim();
    if (text) {
      entries.push({
        text,
        start: parseFloat(match[1]),
        duration: parseFloat(match[2]),
      });
    }
  }
  return entries;
}

function deduplicateEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  const result: TranscriptEntry[] = [];
  for (const entry of entries) {
    const last = result[result.length - 1];
    if (!last || last.text !== entry.text) {
      result.push(entry);
    }
  }
  return result;
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { url } = await req.json();
    if (!url) {
      return new Response(JSON.stringify({ error: 'URL is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return new Response(JSON.stringify({ error: 'Invalid YouTube URL. Please provide a valid YouTube video link.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch the YouTube video page to extract caption data
    const videoPageUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const pageResponse = await fetch(videoPageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!pageResponse.ok) {
      return new Response(JSON.stringify({ error: 'Failed to fetch video page. The video might be private or unavailable.' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const pageHtml = await pageResponse.text();

    // Check for unavailable video
    if (pageHtml.includes('"playabilityStatus":{"status":"ERROR"') ||
        pageHtml.includes('"playabilityStatus":{"status":"UNPLAYABLE"') ||
        pageHtml.includes('"playabilityStatus":{"status":"LOGIN_REQUIRED"')) {
      return new Response(JSON.stringify({ error: 'This video is private, unavailable, or requires login.' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Extract captions data from the page
    const captionsMatch = pageHtml.match(/"captions":\s*(\{.*?"playerCaptionsTracklistRenderer".*?\})\s*,\s*"videoDetails"/s);
    if (!captionsMatch) {
      return new Response(JSON.stringify({ error: 'No captions found for this video. The video may not have subtitles available.' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let captionsData;
    try {
      captionsData = JSON.parse(captionsMatch[1]);
    } catch {
      return new Response(JSON.stringify({ error: 'Failed to parse caption data.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const tracks: CaptionTrack[] = captionsData?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (tracks.length === 0) {
      return new Response(JSON.stringify({ error: 'No caption tracks available for this video.' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Build available languages list
    const availableLanguages = tracks.map((t) => ({
      code: t.languageCode,
      name: t.name?.simpleText || t.name?.runs?.map(r => r.text).join('') || t.languageCode,
      isAutoGenerated: t.kind === 'asr',
    }));

    // Get requested language or default to first track
    const requestedLang = (await req.clone().json().catch(() => ({}))).language;
    const selectedTrack = requestedLang
      ? tracks.find((t) => t.languageCode === requestedLang) || tracks[0]
      : tracks[0];

    // Fetch the caption XML
    const captionUrl = selectedTrack.baseUrl;
    const captionResponse = await fetch(captionUrl);
    if (!captionResponse.ok) {
      return new Response(JSON.stringify({ error: 'Failed to fetch caption data.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const captionXml = await captionResponse.text();
    let entries = parseXmlCaptions(captionXml);
    entries = deduplicateEntries(entries);

    // Build plain text
    const plainText = entries.map((e) => e.text).join(' ');

    // Build timestamped text
    const timestampedText = entries.map((e) => {
      const mins = Math.floor(e.start / 60);
      const secs = Math.floor(e.start % 60);
      return `[${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}] ${e.text}`;
    }).join('\n');

    // Build SRT
    const srtContent = entries.map((e, i) => {
      const startTime = formatTimestamp(e.start);
      const endTime = formatTimestamp(e.start + e.duration);
      return `${i + 1}\n${startTime} --> ${endTime}\n${e.text}\n`;
    }).join('\n');

    // Extract video title
    const titleMatch = pageHtml.match(/<title>(.*?)<\/title>/);
    const videoTitle = titleMatch ? titleMatch[1].replace(' - YouTube', '').trim() : 'YouTube Video';

    return new Response(JSON.stringify({
      videoId,
      videoTitle,
      plainText,
      timestampedText,
      srtContent,
      entries,
      language: {
        code: selectedTrack.languageCode,
        name: selectedTrack.name?.simpleText || selectedTrack.name?.runs?.map(r => r.text).join('') || selectedTrack.languageCode,
        isAutoGenerated: selectedTrack.kind === 'asr',
      },
      availableLanguages,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ error: 'An unexpected error occurred. Please try again.' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
