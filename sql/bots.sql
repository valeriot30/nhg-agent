-- The accounts of the agents (database game). It can be run more than once.
-- The motto says it's a bot; no credits: a bot doesn't buy anything.
insert into users (id, username, look, gender, motto, credits)
values (1001, 'Giulia', 'hr-515-33.hd-600-1.ch-635-70.lg-716-66-62.sh-735-68', 'FEMALE', '[bot] ciao a tutti!', 0)
on conflict (id) do nothing;
