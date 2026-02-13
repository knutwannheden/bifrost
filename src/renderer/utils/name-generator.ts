const adjectives = [
  'swift', 'bold', 'calm', 'deft', 'keen',
  'warm', 'cool', 'wild', 'soft', 'bright',
  'noble', 'brave', 'lucky', 'witty', 'merry',
  'vivid', 'agile', 'crisp', 'snowy', 'stormy',
  'dusty', 'rusty', 'misty', 'foggy', 'sunny',
  'lunar', 'solar', 'coral', 'amber', 'ivory',
  'royal', 'polar', 'rapid', 'quiet', 'happy',
  'fuzzy', 'jolly', 'rosy', 'zesty', 'spicy',
];

const nouns = [
  'fox', 'owl', 'elk', 'lynx', 'wolf',
  'bear', 'hawk', 'dove', 'wren', 'hare',
  'puma', 'orca', 'newt', 'frog', 'swan',
  'crow', 'moth', 'wasp', 'crab', 'mule',
  'finch', 'crane', 'robin', 'otter', 'raven',
  'tiger', 'panda', 'koala', 'eagle', 'bison',
  'cobra', 'gecko', 'llama', 'moose', 'whale',
  'heron', 'viper', 'falcon', 'parrot', 'badger',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateTaskName(): string {
  return `${pick(adjectives)}-${pick(nouns)}`;
}
