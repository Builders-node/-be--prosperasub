import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { secp256k1 } from 'https://esm.sh/@bitauth/libauth@3.0.0?bundle';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const url = new URL(req.url);
    const tag = url.searchParams.get('tag');
    const k1 = url.searchParams.get('k1');
    const sig = url.searchParams.get('sig');
    const key = url.searchParams.get('key');

    // Frontend request: Generate new challenge and LNURL
    if (tag === 'login' && !k1) {
      const challengeBytes = new Uint8Array(32);
      crypto.getRandomValues(challengeBytes);
      const k1Value = Array.from(challengeBytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      // Store in database
      const { error } = await supabase
        .from('lightning_auth_sessions')
        .insert({ k1: k1Value, status: 'pending' });

      if (error) {
        console.error('Database error:', error);
        throw error;
      }

      // Construct LNURL-auth URL with tag=login (per LUD-04 spec)
      const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
      const authUrl = `${supabaseUrl}/functions/v1/lnurl-auth?tag=login&k1=${k1Value}`;
      
      console.log('Generated auth URL:', authUrl);
      
      // Encode as bech32 LNURL using library
      const lnurl = encodeLNURL(authUrl);
      
      console.log('Generated LNURL:', lnurl);
      console.log('LNURL length:', lnurl.length);

      return new Response(
        JSON.stringify({ k1: k1Value, lnurl }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check session status (for frontend polling) - MUST BE BEFORE WALLET METADATA
    if (url.pathname.endsWith('/status') && k1) {
      const { data: session, error } = await supabase
        .from('lightning_auth_sessions')
        .select('*')
        .eq('k1', k1)
        .single();

      if (error || !session) {
        return new Response(
          JSON.stringify({ status: 'pending' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ 
          status: session.status,
          pubkey: session.status === 'verified' ? session.pubkey : null 
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Wallet request: Return LNURL-auth metadata
    if (k1 && !sig && !key) {
      try {
        const userAgent = req.headers.get('user-agent') || 'Unknown';
        const origin = req.headers.get('origin') || 'Unknown';
        const referer = req.headers.get('referer') || 'Unknown';
        
        console.log('=== WALLET METADATA REQUEST ===');
        console.log('K1:', k1);
        console.log('User-Agent:', userAgent);
        console.log('Origin:', origin);
        console.log('Referer:', referer);
        console.log('Full URL:', req.url);
        console.log('===============================');
        
      // Wallet has decoded LNURL and is now requesting auth parameters
        // Note: Wallet will call back with sig and key after user approves
        const { data: session, error: fetchError } = await supabase
          .from('lightning_auth_sessions')
          .select('*')
          .eq('k1', k1)
          .single();

        if (fetchError || !session) {
          console.error('Session not found for k1:', k1, fetchError);
          return new Response(
            JSON.stringify({ status: 'ERROR', reason: 'Invalid session' }),
            { 
              status: 200,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
            }
          );
        }

        console.log('Wallet requesting auth - k1 valid, session found');

        // Per LUD-04: When wallet sees tag=login, it prompts user, then calls back
        // with ?tag=login&k1=...&sig=...&key=...
        // We don't return metadata - the wallet handles everything from the URL
        return new Response(
          JSON.stringify({ status: 'OK' }),
          { 
            status: 200,
            headers: { 
              ...corsHeaders, 
              'Content-Type': 'application/json; charset=utf-8'
            } 
          }
        );
      } catch (metadataError) {
        console.error('Error in metadata handler:', metadataError);
        return new Response(
          JSON.stringify({ status: 'ERROR', reason: 'Internal error' }),
          { 
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          }
        );
      }
    }

    // Wallet callback: Verify signature
    if (k1 && sig && key) {
      const userAgent = req.headers.get('user-agent') || 'Unknown';
      
      console.log('=== WALLET AUTHENTICATION CALLBACK ===');
      console.log('K1:', k1);
      console.log('Signature:', sig.substring(0, 20) + '...');
      console.log('Public Key:', key.substring(0, 20) + '...');
      console.log('User-Agent:', userAgent);
      console.log('===============================');

      // Fetch session
      const { data: session, error: fetchError } = await supabase
        .from('lightning_auth_sessions')
        .select('*')
        .eq('k1', k1)
        .single();

      if (fetchError || !session) {
        console.error('Session not found:', fetchError);
        return new Response(
          JSON.stringify({ status: 'ERROR', reason: 'Invalid session' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Verify signature using secp256k1
      const isValid = await verifySignature(k1, sig, key);

      if (!isValid) {
        console.error('Invalid signature');
        return new Response(
          JSON.stringify({ status: 'ERROR', reason: 'Invalid signature' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Update session with pubkey
      const { error: updateError } = await supabase
        .from('lightning_auth_sessions')
        .update({ status: 'verified', pubkey: key })
        .eq('k1', k1);

      if (updateError) {
        console.error('Update error:', updateError);
        throw updateError;
      }

      // Upsert user
      const { error: upsertError } = await supabase
        .from('users')
        .upsert(
          { lightning_pubkey: key, last_login_at: new Date().toISOString() },
          { onConflict: 'lightning_pubkey' }
        );

      if (upsertError) {
        console.error('User upsert error:', upsertError);
      }

      // Log the login event
      try {
        await supabase.rpc('log_login', {
          p_pubkey: key,
          p_ip_address: null, // Could extract from request headers if needed
          p_user_agent: null
        });
      } catch (logError) {
        console.error('Error logging login:', logError);
      }

      console.log('Authentication successful for pubkey:', key.substring(0, 20));

      return new Response(
        JSON.stringify({ status: 'OK' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Invalid request' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// Verify secp256k1 signature according to LNURL-auth (LUD-04)
async function verifySignature(message: string, signature: string, pubkey: string): Promise<boolean> {
  try {
    // k1, sig and key are provided as hex strings.
    // Per LUD-04, the wallet signs the 32‑byte k1 value directly using
    // ECDSA over secp256k1 and returns a DER‑encoded signature.
    const msgBytes = hexToBytes(message); // 32 bytes
    const sigBytes = hexToBytes(signature); // DER‑encoded ECDSA signature
    const pubkeyBytes = hexToBytes(pubkey); // compressed secp256k1 pubkey (33 bytes)

    // Use libauth's secp256k1 helper which verifies DER‑encoded signatures
    // over secp256k1, enforcing low‑S form as recommended.
    const isValid = secp256k1.verifySignatureDERLowS(sigBytes, pubkeyBytes, msgBytes);
    return isValid;
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

// Helper functions
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Bech32 encoding helper functions
function polymod(values: number[]): number {
  const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) {
        chk ^= GENERATOR[i];
      }
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) {
    ret.push(hrp.charCodeAt(i) >> 5);
  }
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) {
    ret.push(hrp.charCodeAt(i) & 31);
  }
  return ret;
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const polymodValue = polymod(values) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((polymodValue >> (5 * (5 - i))) & 31);
  }
  return checksum;
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  
  for (const value of data) {
    if (value < 0 || (value >> fromBits) !== 0) {
      throw new Error('Invalid data');
    }
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  
  if (pad) {
    if (bits > 0) {
      ret.push((acc << (toBits - bits)) & maxv);
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    throw new Error('Invalid padding');
  }
  
  return ret;
}

// Decode bech32 LNURL back to URL
function decodeLNURL(lnurl: string): string | null {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const hrp = 'lnurl';
  
  try {
    const lnurlLower = lnurl.toLowerCase();
    
    // Check for valid prefix
    if (!lnurlLower.startsWith(hrp + '1')) {
      console.error('Invalid LNURL prefix');
      return null;
    }
    
    // Split hrp and data
    const data = lnurlLower.slice(hrp.length + 1);
    
    // Convert characters back to 5-bit values
    const decoded: number[] = [];
    for (let i = 0; i < data.length; i++) {
      const char = data[i];
      const value = CHARSET.indexOf(char);
      if (value === -1) {
        console.error('Invalid character in LNURL:', char);
        return null;
      }
      decoded.push(value);
    }
    
    // Remove checksum (last 6 characters)
    const payload = decoded.slice(0, -6);
    const checksum = decoded.slice(-6);
    
    // Verify checksum
    const expectedChecksum = createChecksum(hrp, payload);
    if (checksum.join(',') !== expectedChecksum.join(',')) {
      console.error('Invalid LNURL checksum');
      return null;
    }
    
    // Convert 5-bit values back to 8-bit bytes
    const urlBytes = convertBits(new Uint8Array(payload), 5, 8, false);
    
    // Decode to string
    const url = new TextDecoder().decode(new Uint8Array(urlBytes));
    return url;
  } catch (error) {
    console.error('Error decoding LNURL:', error);
    return null;
  }
}

// Encode URL as bech32 LNURL with validation
function encodeLNURL(url: string): string {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const hrp = 'lnurl';
  
  try {
    // Convert URL bytes to 5-bit words
    const urlBytes = new TextEncoder().encode(url);
    const data = convertBits(urlBytes, 8, 5, true);
    
    // Create checksum
    const checksum = createChecksum(hrp, data);
    
    // Combine: hrp + "1" + data + checksum
    const combined = data.concat(checksum);
    
    const encoded = hrp + '1' + combined.map(d => CHARSET[d]).join('');
    console.log('Encoded LNURL from URL:', url);
    console.log('Result:', encoded);
    
    // Validate by decoding
    const decoded = decodeLNURL(encoded);
    if (!decoded || decoded !== url) {
      console.error('LNURL validation failed - decoded URL does not match original');
      console.error('Original:', url);
      console.error('Decoded:', decoded);
      throw new Error('LNURL encoding validation failed');
    }
    
    console.log('✓ LNURL validation passed');
    return encoded;
  } catch (error) {
    console.error('Error encoding LNURL:', error);
    throw error;
  }
}