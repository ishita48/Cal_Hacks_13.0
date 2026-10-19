// A small but complete world frame, shaped exactly like the backend broadcasts, for smoke tests.
import type { Clock, Plan, WorldState } from '../state/types'

export const clock: Clock = {
  step: 300,
  sim_time: 60,
  time_of_day: 23 * 3600 + 41 * 60 + 30 + 60,
  dt: 0.2,
  playing: true,
  speed: 1,
  mode: 'live',
  replay_remaining: 0,
}

export const plan: Plan = {
  version: 3,
  computed_step: 300,
  status: 'draft',
  headline: 'Hold the lifts 6 min for escorts, then cut section B and ATS-EQ. Nobody left behind.',
  rounds: [
    {
      n: 1,
      title: 'First proposal',
      summary: 'Cut now, move everyone to Unit 2 — vetoed by Maya\'s agent',
      feasible: false,
      steps: [],
      stances: [
        { agent: 'safety', label: 'Safety agent', stance: 'propose', reason: 'Cut now.', constraint: null, step_ids: [], resident: null },
        { agent: 'resident:maya', label: "Maya's agent", stance: 'veto', reason: 'Cutting the power now strands Maya on L4.', constraint: { type: 'hard', rule: 'Maya keeps a feasible step-free route', code: 'step_free:maya', source: 'resident:maya' }, step_ids: ['isolate_ats_eq'], resident: 'maya' },
      ],
    },
    {
      n: 2,
      title: 'Revised after objections',
      summary: '3 agents support; every hard constraint holds',
      feasible: true,
      steps: [],
      stances: [
        { agent: 'resident:maya', label: "Maya's agent", stance: 'support', reason: 'Lift escort finishes at +6 min.', constraint: null, step_ids: ['escort_maya'], resident: 'maya' },
        { agent: 'checker', label: 'Checker agent', stance: 'support', reason: '10 checks pass.', constraint: null, step_ids: [], resident: null },
      ],
    },
  ],
  steps: [
    { id: 'escort_maya', order: 1, kind: 'escort', actor: 'staff', title: 'Two staff bring Maya Reyes down by lift first', reason: 'Wheelchair user.', at_s: 120, deadline_s: 360, people: ['maya'], target: 'L1-lobby', command: null, satisfies: ['resident:maya'], count: 1 },
    { id: 'isolate_ats_eq', order: 2, kind: 'isolate', actor: 'facilities', title: 'Cut ATS-EQ (lifts stop)', reason: 'Water.', at_s: 360, deadline_s: null, people: [], target: 'ats_eq', command: { equipment_id: 'ats_eq', command: 'off' }, satisfies: ['safety'], count: 0 },
  ],
  stances: [],
  left_behind: [],
  metrics: { residents_affected: 250, relocated: 221, escorted: 9, left_behind: 0, violations: 0, checks: 10, water_contact_min: 12.5 },
  enabled_agents: ['safety', 'housing', 'capacity', 'checker', 'resident:maya'],
  rules: [],
  messages: [
    { id: 'msg_01_maya', to: 'maya', name: 'Maya Reyes', role: 'resident', channel: 'call', lang: 'en', priority: 'critical', text: 'Maya, staff are coming to your door.', step_ids: ['escort_maya'], count: 1 },
  ],
  checks: [
    { code: 'deenergise_before_contact', label: 'Switchgear isolated before water contact', ok: true, detail: 'cut at +6 min', severity: 'safety' },
  ],
  signature: 1,
}
plan.stances = plan.rounds[1].stances

export const world: WorldState = {
  run_id: 'test',
  scenario: 'blackwell_basement_leak',
  mode: 'live',
  narrative: {
    stage: 'negotiate',
    headline: 'Water is pouring into the mechanical room: 150 L/s from the domestic water riser.',
    detail: 'In 12 min the water reaches MSB section B: the lifts stop and floors 3 and 4 go dark. Maya (wheelchair user, floor 4) would be stranded: no step-free way out.',
    next: 'The agents propose: Hold the lifts 6 min for escorts, then cut section B and ATS-EQ. Nobody left behind.',
    ask: 'Approve the plan here or on the manager\'s phone, say a rule to change it, or switch an agent off to see what it protects.',
    people: ['maya'],
    contact_in_s: 750,
    contact_at_s: 810,
    contact_name: 'MSB section B',
    affected_if_nothing_done: 751,
    affected_by_plan: 250,
  },
  step: 300,
  version: 7,
  sensors: { basement_mech_1: { value: 0.9, wet: true, last_step: 25, source: 'manual' } },
  timeline: [
    { step: 25, kind: 'sensor_wet', severity: 'critical', message: 'Water detected by basement_mech_1', data: {} },
    { step: 38, kind: 'wet', severity: 'warning', message: 'Water entering Mechanical room (B1)', data: {} },
  ],
  water: { 'B1-mech': { depth: 0.04, volume: 11.5 } },
  wet_spaces: ['B1-mech'],
  leaks: { water_riser: { equipment_id: 'water_riser', space: 'B1-mech', flow_lps: 150, started_step: 25, active: true } },
  flooded: [],
  isolated: [],
  closed_valves: [],
  pending: [],
  agents: { safety: true, housing: true, capacity: true, checker: true, 'resident:maya': true },
  rules: [],
  approved_plan_version: null,
  approved_plan: null,
  actions: {},
  moved: {},
  actors: {
    staff: { actor: 'staff', label: 'Desk staff', at: 'L1-lobby', heading: 'room_412', step_id: 'escort_maya', status: 'moving', since_step: 280 },
    plumber: { actor: 'plumber', label: 'Plumber', at: null, heading: null, step_id: null, status: 'offsite', since_step: 0 },
  },
  equipment: { msb_b: { status: 'online', since_step: 0 }, main_valve: { status: 'online', since_step: 0 }, lift_1: { status: 'online', since_step: 0 } },
  power: { live: ['lift_1', 'lift_2'], levels: { L3: true, L4: true }, lifts: { lift_1: true, lift_2: true } },
  impact: { dark_levels: [], lifts_down: [], fridges_down: [], wet_spaces: ['B1-mech'], residents: [], others: [], routes: { maya: ['room_412', 'L4-cor_spine', 'L4-lift_1', 'L1-lift_1', 'L1-lobby', 'outside'] }, counts: { affected: 0 } },
  forecast: {
    computed_step: 25,
    horizon_s: 3600,
    settled: false,
    events: [
      { eta_s: 750, kind: 'flooded', id: 'msb_b', message: 'MSB section B under water (10 cm)', severity: 'critical', cause: 'B1-elec', data: {} },
      { eta_s: 750, kind: 'lifts_down', id: 'lifts', message: 'Lifts offline', severity: 'critical', cause: 'lift_1_ctrl', data: {} },
    ],
    impact: {
      dark_levels: ['L3', 'L4'],
      lifts_down: ['lift_1', 'lift_2'],
      fridges_down: ['fridge_L3'],
      wet_spaces: ['B1-mech', 'B1-elec'],
      residents: [
        { id: 'maya', name: 'Maya Reyes', room: 'room_412', level: 'L4', presence: 'in_room', needs: ['step_free_route'], impacts: ['stranded', 'power_lost'], severity: 'critical', channel: 'call', lang: 'en', role: 'resident' },
      ],
      others: ['r_0001'],
      routes: { maya: null },
      counts: { affected: 250, stranded: 2, medication_at_risk: 3 },
    },
  },
  plan,
}
