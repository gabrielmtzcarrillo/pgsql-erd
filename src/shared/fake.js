// Deterministic fake data for generator scripts, with a subset of the
// @faker-js/faker API. Seeded so a dry run and the following run can be
// reproduced with faker.seed(n).

const FIRST = ['Ana', 'Luis', 'María', 'José', 'Carmen', 'Jorge', 'Lucía', 'Carlos', 'Sofía', 'Miguel', 'Elena', 'Diego',
  'Laura', 'Pablo', 'Valeria', 'Andrés', 'Paula', 'Fernando', 'Daniela', 'Ricardo', 'Emma', 'Liam', 'Olivia', 'Noah',
  'Ava', 'James', 'Mia', 'Lucas', 'Grace', 'Henry', 'Chloe', 'Samuel', 'Isabel', 'Adrián', 'Gabriela', 'Héctor'];
const LAST = ['García', 'Martínez', 'López', 'Hernández', 'González', 'Pérez', 'Rodríguez', 'Sánchez', 'Ramírez', 'Torres',
  'Flores', 'Rivera', 'Gómez', 'Díaz', 'Cruz', 'Morales', 'Reyes', 'Ortiz', 'Smith', 'Johnson', 'Williams', 'Brown',
  'Jones', 'Miller', 'Davis', 'Wilson', 'Taylor', 'Clark', 'Lewis', 'Walker', 'Young', 'Allen', 'Castillo', 'Vargas'];
const JOBS = ['Analyst', 'Engineer', 'Manager', 'Coordinator', 'Assistant', 'Director', 'Technician', 'Consultant',
  'Professor', 'Researcher', 'Accountant', 'Designer', 'Developer', 'Administrator', 'Supervisor'];
const CITIES = ['Monterrey', 'Guadalajara', 'Ciudad de México', 'Puebla', 'Querétaro', 'Mérida', 'Madrid', 'Bogotá',
  'Lima', 'Santiago', 'Buenos Aires', 'Austin', 'Chicago', 'Toronto', 'Seattle', 'Denver', 'Boston', 'Lisbon'];
const COUNTRIES = ['Mexico', 'Spain', 'Colombia', 'Peru', 'Chile', 'Argentina', 'United States', 'Canada', 'Portugal'];
const STREETS = ['Juárez', 'Hidalgo', 'Morelos', 'Reforma', 'Main', 'Oak', 'Maple', 'Cedar', 'Pine', 'Lake', 'Hill'];
const COMPANY = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Stark', 'Wayne', 'Hooli', 'Vandelay', 'Soylent', 'Tyrell'];
const SUFFIX = ['S.A. de C.V.', 'Inc.', 'LLC', 'Group', 'Labs', 'Systems', 'Partners'];
const DEPARTMENTS = ['Finance', 'Human Resources', 'Engineering', 'Sales', 'Marketing', 'Operations', 'Legal',
  'Research', 'Support', 'Procurement', 'Academic Affairs', 'IT'];
const DOMAINS = ['example.com', 'example.org', 'example.net', 'test.local'];
const WORDS = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et ' +
  'dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo').split(' ');

const ascii = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function createFaker(seedValue = Date.now()) {
  let s = 0;
  const seed = (v) => {
    s = (Number(v) >>> 0) || 0x9e3779b9;
  };
  seed(seedValue);
  // mulberry32
  const random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (opts = {}) => {
    const o = typeof opts === 'number' ? { max: opts } : opts;
    const min = Math.ceil(o.min ?? 0);
    const max = Math.floor(o.max ?? Number.MAX_SAFE_INTEGER);
    return min + Math.floor(random() * (max - min + 1));
  };
  const pick = (items) => items[Math.floor(random() * items.length)];
  const chars = (set, n) => Array.from({ length: n }, () => set[Math.floor(random() * set.length)]).join('');
  const toDate = (d) => (d instanceof Date ? d : new Date(d));
  const between = (from, to) => {
    const a = toDate(from).getTime();
    const b = toDate(to).getTime();
    return new Date(a + random() * (b - a));
  };
  const now = () => Date.now();
  const shuffle = (items) => {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const words = (n = 3) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
  const sentence = (n = int({ min: 5, max: 12 })) => {
    const w = words(n);
    return `${w[0].toUpperCase()}${w.slice(1)}.`;
  };

  const faker = {
    seed,
    random,
    person: {
      firstName: () => pick(FIRST),
      lastName: () => pick(LAST),
      fullName: () => `${pick(FIRST)} ${pick(LAST)}`,
      jobTitle: () => pick(JOBS),
    },
    internet: {
      userName: (name) => {
        const base = name ? ascii(name) : `${ascii(pick(FIRST))}.${ascii(pick(LAST))}`;
        return `${base}${int({ min: 1, max: 999 })}`;
      },
      email: (name) => `${faker.internet.userName(name)}@${pick(DOMAINS)}`,
      url: () => `https://${ascii(pick(COMPANY))}.${pick(DOMAINS)}`,
    },
    phone: { number: () => `+52 ${chars('0123456789', 2)} ${chars('0123456789', 4)} ${chars('0123456789', 4)}` },
    location: {
      city: () => pick(CITIES),
      country: () => pick(COUNTRIES),
      streetAddress: () => `${pick(STREETS)} ${int({ min: 1, max: 2999 })}`,
      zipCode: () => chars('0123456789', 5),
    },
    company: {
      name: () => `${pick(COMPANY)} ${pick(SUFFIX)}`,
      department: () => pick(DEPARTMENTS),
    },
    lorem: {
      word: () => pick(WORDS),
      words,
      sentence,
      paragraph: (n = 3) => Array.from({ length: n }, () => sentence()).join(' '),
    },
    number: {
      int,
      float: (o = {}) => {
        const min = o.min ?? 0;
        const max = o.max ?? 1;
        const v = min + random() * (max - min);
        return o.fractionDigits === undefined ? v : Number(v.toFixed(o.fractionDigits));
      },
    },
    datatype: { boolean: (p = 0.5) => random() < p },
    date: {
      past: (years = 1) => new Date(now() - random() * years * 365.25 * 864e5),
      future: (years = 1) => new Date(now() + random() * years * 365.25 * 864e5),
      recent: (days = 1) => new Date(now() - random() * days * 864e5),
      between,
      birthdate: (o = {}) => {
        const age = int({ min: o.min ?? 18, max: o.max ?? 80 });
        const d = new Date(now() - age * 365.25 * 864e5 - random() * 364 * 864e5);
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      },
    },
    string: {
      uuid: () => {
        const h = chars('0123456789abcdef', 32).split('');
        h[12] = '4';
        h[16] = '89ab'[Math.floor(random() * 4)];
        const x = h.join('');
        return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
      },
      alpha: (n = 8) => chars('abcdefghijklmnopqrstuvwxyz', n),
      numeric: (n = 6) => chars('0123456789', n),
      alphanumeric: (n = 8) => chars('abcdefghijklmnopqrstuvwxyz0123456789', n),
    },
    helpers: {
      arrayElement: pick,
      arrayElements: (items, count) => shuffle(items).slice(0, count ?? int({ min: 1, max: items.length })),
      shuffle,
      weighted: (items) => {
        const total = items.reduce((a, i) => a + i.weight, 0);
        let r = random() * total;
        for (const i of items) if ((r -= i.weight) < 0) return i.value;
        return items[items.length - 1].value;
      },
    },
  };
  return faker;
}
