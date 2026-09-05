CREATE EXTENSION IF NOT EXISTS "pg_graphql";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "plpgsql";
CREATE EXTENSION IF NOT EXISTS "supabase_vault";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.1

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: app_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.app_role AS ENUM (
    'admin',
    'moderator',
    'user'
);


--
-- Name: check_user_admin_status(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_user_admin_status(p_pubkey text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON u.id = ur.user_id
    WHERE u.lightning_pubkey = p_pubkey
      AND ur.role = 'admin'
  )
$$;


--
-- Name: get_user_login_history(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_login_history(p_pubkey text) RETURNS TABLE(id uuid, user_id uuid, logged_in_at timestamp with time zone, ip_address text, user_agent text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT lh.id, lh.user_id, lh.logged_in_at, lh.ip_address, lh.user_agent
  FROM public.login_history lh
  JOIN public.users u ON lh.user_id = u.id
  WHERE u.lightning_pubkey = p_pubkey
  ORDER BY lh.logged_in_at DESC
  LIMIT 10;
$$;


--
-- Name: get_user_nwc_connection(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_nwc_connection(p_pubkey text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_nwc TEXT;
BEGIN
  SELECT nwc_connection_string INTO v_nwc 
  FROM public.users 
  WHERE lightning_pubkey = p_pubkey;
  
  RETURN v_nwc;
END;
$$;


--
-- Name: get_user_profile(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_profile(p_pubkey text) RETURNS TABLE(id uuid, lightning_pubkey text, display_name text, avatar_url text, created_at timestamp with time zone, last_login_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT id, lightning_pubkey, display_name, avatar_url, created_at, last_login_at
  FROM public.users
  WHERE lightning_pubkey = p_pubkey;
$$;


--
-- Name: get_user_tournament_application(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_tournament_application(p_pubkey text) RETURNS TABLE(id uuid, name text, email text, telegram_username text, chess_com_account text, current_rating integer, highest_rating integer, payment_status text, amount_sats integer, created_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_user_id UUID;
BEGIN
  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;
  
  RETURN QUERY
  SELECT 
    ta.id,
    ta.name,
    ta.email,
    ta.telegram_username,
    ta.chess_com_account,
    ta.current_rating,
    ta.highest_rating,
    ta.payment_status,
    ta.amount_sats,
    ta.created_at
  FROM public.tournament_applications ta
  WHERE ta.user_id = v_user_id
  ORDER BY ta.created_at DESC
  LIMIT 1;
END;
$$;


--
-- Name: has_role(uuid, public.app_role); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;


--
-- Name: log_login(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_login(p_pubkey text, p_ip_address text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_user_id UUID;
BEGIN
  -- Get user_id from pubkey
  SELECT id INTO v_user_id
  FROM public.users
  WHERE lightning_pubkey = p_pubkey;

  -- Insert login history
  IF v_user_id IS NOT NULL THEN
    INSERT INTO public.login_history (user_id, ip_address, user_agent)
    VALUES (v_user_id, p_ip_address, p_user_agent);
  END IF;
END;
$$;


--
-- Name: submit_tournament_application(text, text, text, integer, integer, text, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.submit_tournament_application(p_pubkey text, p_name text, p_chess_com_account text, p_current_rating integer, p_highest_rating integer, p_payment_hash text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_telegram_username text DEFAULT NULL::text, p_amount_sats integer DEFAULT 10000) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_user_id UUID;
BEGIN
  SELECT u.id INTO v_user_id
  FROM public.users u
  WHERE u.lightning_pubkey = p_pubkey;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found for pubkey';
  END IF;
  
  INSERT INTO public.tournament_applications (
    user_id,
    name,
    chess_com_account,
    current_rating,
    highest_rating,
    payment_status,
    payment_hash,
    email,
    telegram_username,
    amount_sats
  )
  VALUES (
    v_user_id,
    p_name,
    p_chess_com_account,
    p_current_rating,
    p_highest_rating,
    CASE WHEN p_payment_hash IS NOT NULL THEN 'paid' ELSE 'pending' END,
    p_payment_hash,
    p_email,
    p_telegram_username,
    p_amount_sats
  );
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_user_nwc_connection(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_user_nwc_connection(p_pubkey text, p_nwc_connection text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_user_id UUID;
BEGIN
  SELECT id INTO v_user_id FROM public.users WHERE lightning_pubkey = p_pubkey;
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  
  UPDATE public.users
  SET nwc_connection_string = p_nwc_connection
  WHERE id = v_user_id;
END;
$$;


--
-- Name: update_user_profile(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_user_profile(p_pubkey text, p_display_name text, p_avatar_url text) RETURNS TABLE(id uuid, lightning_pubkey text, display_name text, avatar_url text, created_at timestamp with time zone, last_login_at timestamp with time zone)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  UPDATE public.users
  SET 
    display_name = p_display_name,
    avatar_url = p_avatar_url
  WHERE lightning_pubkey = p_pubkey
  RETURNING id, lightning_pubkey, display_name, avatar_url, created_at, last_login_at;
$$;


SET default_table_access_method = heap;

--
-- Name: lightning_auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lightning_auth_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    k1 text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    pubkey text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:05:00'::interval) NOT NULL
);


--
-- Name: login_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    logged_in_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address text,
    user_agent text
);


--
-- Name: tournament_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tournament_applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    name text NOT NULL,
    chess_com_account text NOT NULL,
    current_rating integer NOT NULL,
    highest_rating integer NOT NULL,
    payment_status text DEFAULT 'pending'::text NOT NULL,
    payment_hash text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    email text,
    telegram_username text,
    amount_sats integer DEFAULT 10000,
    deleted_at timestamp with time zone
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role public.app_role NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lightning_pubkey text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone,
    display_name text,
    avatar_url text,
    nwc_connection_string text
);


--
-- Name: lightning_auth_sessions lightning_auth_sessions_k1_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lightning_auth_sessions
    ADD CONSTRAINT lightning_auth_sessions_k1_key UNIQUE (k1);


--
-- Name: lightning_auth_sessions lightning_auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lightning_auth_sessions
    ADD CONSTRAINT lightning_auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: login_history login_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_history
    ADD CONSTRAINT login_history_pkey PRIMARY KEY (id);


--
-- Name: tournament_applications tournament_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tournament_applications
    ADD CONSTRAINT tournament_applications_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_user_id_role_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_role_key UNIQUE (user_id, role);


--
-- Name: users users_lightning_pubkey_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_lightning_pubkey_key UNIQUE (lightning_pubkey);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_lightning_auth_sessions_k1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lightning_auth_sessions_k1 ON public.lightning_auth_sessions USING btree (k1);


--
-- Name: idx_lightning_auth_sessions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lightning_auth_sessions_status ON public.lightning_auth_sessions USING btree (status);


--
-- Name: idx_login_history_logged_in_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_login_history_logged_in_at ON public.login_history USING btree (logged_in_at DESC);


--
-- Name: idx_login_history_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_login_history_user_id ON public.login_history USING btree (user_id);


--
-- Name: idx_tournament_applications_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tournament_applications_deleted_at ON public.tournament_applications USING btree (deleted_at);


--
-- Name: idx_users_lightning_pubkey; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_lightning_pubkey ON public.users USING btree (lightning_pubkey);


--
-- Name: tournament_applications update_tournament_applications_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_tournament_applications_updated_at BEFORE UPDATE ON public.tournament_applications FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: login_history login_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_history
    ADD CONSTRAINT login_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tournament_applications tournament_applications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tournament_applications
    ADD CONSTRAINT tournament_applications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tournament_applications Admins can delete applications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete applications" ON public.tournament_applications FOR DELETE USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: user_roles Admins can manage all roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage all roles" ON public.user_roles TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: tournament_applications Admins can update all applications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update all applications" ON public.tournament_applications FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: tournament_applications Admins can view all applications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all applications" ON public.tournament_applications FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: users Allow insert for authenticated sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow insert for authenticated sessions" ON public.users FOR INSERT WITH CHECK (true);


--
-- Name: lightning_auth_sessions Anyone can create auth sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can create auth sessions" ON public.lightning_auth_sessions FOR INSERT WITH CHECK (true);


--
-- Name: lightning_auth_sessions Anyone can update their session; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can update their session" ON public.lightning_auth_sessions FOR UPDATE USING (true);


--
-- Name: lightning_auth_sessions Anyone can view pending sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view pending sessions" ON public.lightning_auth_sessions FOR SELECT USING (true);


--
-- Name: login_history System can insert login history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System can insert login history" ON public.login_history FOR INSERT WITH CHECK (true);


--
-- Name: tournament_applications Users can insert their own applications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own applications" ON public.tournament_applications FOR INSERT TO authenticated WITH CHECK ((user_id IN ( SELECT users.id
   FROM public.users
  WHERE (users.lightning_pubkey = current_setting('app.current_pubkey'::text, true)))));


--
-- Name: users Users can update their own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own profile" ON public.users FOR UPDATE USING ((lightning_pubkey = current_setting('app.current_pubkey'::text, true)));


--
-- Name: tournament_applications Users can view their own applications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own applications" ON public.tournament_applications FOR SELECT TO authenticated USING ((user_id IN ( SELECT users.id
   FROM public.users
  WHERE (users.lightning_pubkey = current_setting('app.current_pubkey'::text, true)))));


--
-- Name: users Users can view their own data; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own data" ON public.users FOR SELECT USING ((lightning_pubkey = current_setting('app.current_pubkey'::text, true)));


--
-- Name: login_history Users can view their own login history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own login history" ON public.login_history FOR SELECT USING ((user_id IN ( SELECT users.id
   FROM public.users
  WHERE (users.lightning_pubkey = current_setting('app.current_pubkey'::text, true)))));


--
-- Name: user_roles Users can view their own roles via pubkey; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own roles via pubkey" ON public.user_roles FOR SELECT USING ((user_id IN ( SELECT users.id
   FROM public.users
  WHERE (users.lightning_pubkey = current_setting('app.current_pubkey'::text, true)))));


--
-- Name: lightning_auth_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lightning_auth_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: login_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.login_history ENABLE ROW LEVEL SECURITY;

--
-- Name: tournament_applications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tournament_applications ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


