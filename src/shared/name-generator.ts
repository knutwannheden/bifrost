const adjectives = [
  'swift', 'bold', 'calm', 'deft', 'keen',
  'warm', 'cool', 'wild', 'soft', 'bright',
  'noble', 'brave', 'lucky', 'witty', 'merry',
  'vivid', 'agile', 'crisp', 'snowy', 'stormy',
  'dusty', 'rusty', 'misty', 'foggy', 'sunny',
  'lunar', 'solar', 'coral', 'amber', 'ivory',
  'royal', 'polar', 'rapid', 'quiet', 'happy',
  'fuzzy', 'jolly', 'rosy', 'zesty', 'spicy',
  'plucky', 'daring', 'peppy', 'sly', 'giddy',
  'cosmic', 'turbo', 'sneaky', 'bouncy', 'lanky',
  'frothy', 'chunky', 'silky', 'wonky', 'funky',
  'mighty', 'tiny', 'epic', 'dizzy', 'fancy',
  'feral', 'nimble', 'oddly', 'wiry', 'brisk',
  'plush', 'grumpy', 'shrewd', 'loopy', 'zippy',
  'glossy', 'surly', 'gnarly', 'chirpy', 'husky',
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
  'yak', 'sloth', 'lemur', 'squid', 'stoat',
  'quail', 'ibis', 'dingo', 'tapir', 'axolotl',
  'ferret', 'osprey', 'mantis', 'narwhal', 'walrus',
  'toucan', 'jackal', 'condor', 'iguana', 'chinchilla',
  'pelican', 'wombat', 'donkey', 'shrimp', 'oyster',
  'alpaca', 'marmot', 'puffin', 'capybara', 'pangolin',
  'raccoon', 'lobster', 'peacock', 'hamster', 'octopus',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateTaskName(): string {
  return `${pick(adjectives)}-${pick(nouns)}`;
}
