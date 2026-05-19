import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-lightning-pubkey',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, PATCH, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const pubkey = req.headers.get('x-lightning-pubkey')
    
    if (!pubkey) {
      return new Response(
        JSON.stringify({ error: 'Lightning pubkey required' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get user ID from pubkey
    const { data: userData, error: userError } = await supabaseClient
      .from('users')
      .select('id')
      .eq('lightning_pubkey', pubkey)
      .single()

    if (userError || !userData) {
      return new Response(
        JSON.stringify({ error: 'User not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Check if user has admin role
    const { data: roleData, error: roleError } = await supabaseClient
      .from('user_roles')
      .select('role')
      .eq('user_id', userData.id)
      .eq('role', 'admin')
      .maybeSingle()

    if (roleError || !roleData) {
      return new Response(
        JSON.stringify({ error: 'Access denied. Admin role required.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Handle PATCH request (soft delete / restore)
    if (req.method === 'PATCH') {
      const { applicationIds, action } = await req.json()
      
      if (!applicationIds || !Array.isArray(applicationIds) || applicationIds.length === 0) {
        return new Response(
          JSON.stringify({ error: 'Application IDs required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      if (action === 'soft-delete') {
        const { error: updateError } = await supabaseClient
          .from('tournament_applications')
          .update({ deleted_at: new Date().toISOString() })
          .in('id', applicationIds)

        if (updateError) {
          throw updateError
        }

        return new Response(
          JSON.stringify({ success: true, action: 'soft-deleted', count: applicationIds.length }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      if (action === 'restore') {
        const { error: updateError } = await supabaseClient
          .from('tournament_applications')
          .update({ deleted_at: null })
          .in('id', applicationIds)

        if (updateError) {
          throw updateError
        }

        return new Response(
          JSON.stringify({ success: true, action: 'restored', count: applicationIds.length }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      return new Response(
        JSON.stringify({ error: 'Invalid action. Use "soft-delete" or "restore"' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Handle DELETE request (permanent delete)
    if (req.method === 'DELETE') {
      const { applicationIds } = await req.json()
      
      if (!applicationIds || !Array.isArray(applicationIds) || applicationIds.length === 0) {
        return new Response(
          JSON.stringify({ error: 'Application IDs required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const { error: deleteError } = await supabaseClient
        .from('tournament_applications')
        .delete()
        .in('id', applicationIds)

      if (deleteError) {
        throw deleteError
      }

      return new Response(
        JSON.stringify({ success: true, deleted: applicationIds.length }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Handle GET request - Fetch applications
    const url = new URL(req.url)
    const showDeleted = url.searchParams.get('deleted') === 'true'

    let query = supabaseClient
      .from('tournament_applications')
      .select('*')
      .order('created_at', { ascending: false })

    if (showDeleted) {
      query = query.not('deleted_at', 'is', null)
    } else {
      query = query.is('deleted_at', null)
    }

    const { data: applications, error: appsError } = await query

    if (appsError) {
      throw appsError
    }

    return new Response(
      JSON.stringify({ applications }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Error:', error)
    const message = error instanceof Error ? error.message : 'An unexpected error occurred'
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
