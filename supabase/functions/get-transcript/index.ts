import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const YT_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

interface TranscriptEntry { text: string; start: number; duration: number; }

function fmtTs(s: number): string {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60), ms = Math.floor((s%1)*1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

function dedup(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((e, i) => i === 0 || e.text !== entries[i-1].text);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { url } = await req.json();
    if (!url) return new Response(JSON.stringify({ error: 'URL is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const videoId = extractVideoId(url);
    if (!videoId) return new Response(JSON.stringify({ error: 'Invalid YouTube URL.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    console.log('Processing video:', videoId);

    // Step 1: Fetch the watch page to get cookies + transcript continuation token
    const watchRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!watchRes.ok) {
      await watchRes.text();
      return new Response(JSON.stringify({ error: 'Failed to access YouTube.' }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const html = await watchRes.text();
    const cookies = watchRes.headers.get('set-cookie') || '';

    // Extract video title
    const titleMatch = html.match(/"title"\s*:\s*"([^"]+)"/);
    const videoTitle = titleMatch ? titleMatch[1] : 'YouTube Video';

    // Check if video is available
    if (html.includes('"status":"LOGIN_REQUIRED"')) {
      return new Response(JSON.stringify({ error: 'This video is private or requires login.' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (html.includes('"status":"ERROR"') && !html.includes('"captionTracks"')) {
      return new Response(JSON.stringify({ error: 'This video is unavailable.' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Find the transcript continuation token (params for get_transcript endpoint)
    const paramsMatches = [...html.matchAll(/"params"\s*:\s*"([A-Za-z0-9+/=_-]{20,})"/g)];
    // Also look for serializedShareEntity or getTranscriptEndpoint params
    const transcriptParamMatch = html.match(/"getTranscriptEndpoint"\s*:\s*\{[^}]*"params"\s*:\s*"([^"]+)"/);
    
    let transcriptParams = transcriptParamMatch ? transcriptParamMatch[1] : '';
    
    // If no direct match, try to find it near "Show transcript" or engagement panels
    if (!transcriptParams) {
      // Look for engagement panel params that are likely transcript-related
      const engagementMatch = html.match(/engagementPanelSectionListRenderer.*?"getTranscriptEndpoint".*?"params"\s*:\s*"([^"]+)"/s);
      if (engagementMatch) transcriptParams = engagementMatch[1];
    }
    
    console.log('Found transcript params:', transcriptParams ? 'yes' : 'no');

    // Extract visitorData for context
    const vdMatch = html.match(/"visitorData"\s*:\s*"([^"]+)"/);
    const visitorData = vdMatch ? vdMatch[1] : '';

    const context: any = {
      client: {
        hl: 'en',
        gl: 'US',
        clientName: 'WEB',
        clientVersion: '2.20241028.01.00',
      },
    };
    if (visitorData) context.client.visitorData = visitorData;

    const fetchHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Origin': 'https://www.youtube.com',
      'Referer': `https://www.youtube.com/watch?v=${videoId}`,
    };
    if (cookies) fetchHeaders['Cookie'] = cookies;

    if (transcriptParams) {
      // Step 2: Use get_transcript endpoint
      console.log('Fetching transcript via get_transcript endpoint...');
      const transcriptRes = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${YT_API_KEY}&prettyPrint=false`, {
        method: 'POST',
        headers: fetchHeaders,
        body: JSON.stringify({ context, params: transcriptParams }),
      });

      if (transcriptRes.ok) {
        const data = await transcriptRes.json();
        console.log('get_transcript response keys:', Object.keys(data));
        
        // Navigate the response structure
        const actions = data?.actions || [];
        let cueGroups: any[] = [];
        
        for (const action of actions) {
          const body = action?.updateEngagementPanelAction?.content
            ?.transcriptRenderer?.body?.transcriptBodyRenderer;
          if (body?.cueGroups) {
            cueGroups = body.cueGroups;
            break;
          }
        }
        
        // Also check for transcriptSearchPanelRenderer
        if (cueGroups.length === 0) {
          const searchBody = data?.refinements || data?.body?.transcriptBodyRenderer;
          if (searchBody?.cueGroups) cueGroups = searchBody.cueGroups;
        }

        console.log('Found', cueGroups.length, 'cue groups');

        if (cueGroups.length > 0) {
          const entries: TranscriptEntry[] = cueGroups.map((g: any) => {
            const cue = g?.transcriptCueGroupRenderer?.cues?.[0]?.transcriptCueRenderer;
            if (!cue) return null;
            const text = cue.cue?.simpleText || cue.cue?.runs?.map((r: any) => r.text).join('') || '';
            return {
              text: text.replace(/\n/g, ' ').trim(),
              start: parseInt(cue.startOffsetMs || '0') / 1000,
              duration: parseInt(cue.durationMs || '0') / 1000,
            };
          }).filter((e: any) => e && e.text) as TranscriptEntry[];

          const dedupedEntries = dedup(entries);
          
          if (dedupedEntries.length > 0) {
            const plainText = dedupedEntries.map(e => e.text).join(' ');
            const timestampedText = dedupedEntries.map(e => {
              const m = Math.floor(e.start / 60), s = Math.floor(e.start % 60);
              return `[${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}] ${e.text}`;
            }).join('\n');
            const srtContent = dedupedEntries.map((e, i) => `${i+1}\n${fmtTs(e.start)} --> ${fmtTs(e.start+e.duration)}\n${e.text}\n`).join('\n');

            return new Response(JSON.stringify({
              videoId, videoTitle, plainText, timestampedText, srtContent,
              entries: dedupedEntries,
              language: { code: 'en', name: 'English', isAutoGenerated: true },
              availableLanguages: [{ code: 'en', name: 'English', isAutoGenerated: true }],
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
        }
      } else {
        const errText = await transcriptRes.text();
        console.log('get_transcript failed:', transcriptRes.status, errText.substring(0, 200));
      }
    }

    // Fallback: no transcript params found
    // Check if captions exist at all
    if (!html.includes('"captionTracks"')) {
      return new Response(JSON.stringify({ error: 'No captions found for this video. The video may not have subtitles.' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Could not extract transcript. YouTube may be blocking server-side access. Please try again later.' }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ error: 'An unexpected error occurred. Please try again.' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
