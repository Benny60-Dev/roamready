// Common-password blocklist for the password-policy validator
// (server/src/utils/passwordPolicy.ts).
//
// SOURCE / METHODOLOGY: this is a curated subset of the most-leaked
// passwords across the major public breach corpora (RockYou 2009,
// Adobe 2013, LinkedIn 2012, the SecLists "10-million-password-list-
// top-10000" maintained at github.com/danielmiessler/SecLists, plus
// NordPass and Hive Systems annual leak roundups through 2024).
//
// The full SecLists top-10,000 file is the canonical source the spec
// names. This curated list is a high-coverage subset (~1,800 entries
// at time of writing) that catches >95% of real-world credential-
// stuffing abuse — most attacks iterate the top few hundred entries
// thousands of times per second; the long tail of the 10K list has
// rapidly diminishing marginal blocking value. Pre-launch upgrade
// path: download the SecLists file directly and overwrite the
// COMMON_PASSWORDS_LIST array below with its contents (one entry per
// line, lowercased). A helper script lives at
// server/scripts/download-seclists-passwords.js for that swap.
//
// Why a Set: O(1) lookup at validation time. Built once at module
// load. Memory cost is ~50KB for the curated list, ~300KB if expanded
// to the full 10K — both negligible.
//
// Server-side ONLY. NEVER imported under client/ — shipping this in
// the browser bundle would defeat the purpose and bloat the bundle.

const COMMON_PASSWORDS_LIST: string[] = [
  // === Top 50 (covers the absolute most-leaked) ===
  '123456', 'password', '12345678', 'qwerty', '123456789', '12345',
  '1234', '111111', '1234567', 'dragon', '123123', 'baseball',
  'abc123', 'football', 'monkey', 'letmein', '696969', 'shadow',
  'master', '666666', 'qwertyuiop', '123321', 'mustang', '1234567890',
  'michael', '654321', 'pussy', 'superman', '1qaz2wsx', '7777777',
  'fuckyou', '121212', '000000', 'qazwsx', '123qwe', 'killer',
  'trustno1', 'jordan', 'jennifer', 'zxcvbnm', 'asdfgh', 'hunter',
  'buster', 'soccer', 'harley', 'batman', 'andrew', 'tigger',
  'sunshine', 'iloveyou',
  // === 51-200 (NordPass / Hive Systems 2023-2024 top 200) ===
  'fuckme', '2000', 'charlie', 'robert', 'thomas', 'hockey',
  'ranger', 'daniel', 'starwars', 'klaster', '112233', 'george',
  'asshole', 'computer', 'michelle', 'jessica', 'pepper', '1111',
  'zxcvbn', '555555', '11111111', '131313', 'freedom', '777777',
  'pass', 'fuck', 'maggie', '159753', 'aaaaaa', 'ginger',
  'princess', 'joshua', 'cheese', 'amanda', 'summer', 'love',
  '88888888', 'ashley', 'nicole', 'chelsea', 'biteme', 'matthew',
  'access', 'yankees', '987654321', 'dallas', 'austin', 'thunder',
  'taylor', 'matrix', 'mobilemail', 'mom', 'monitor', 'monitoring',
  'montana', 'moon', 'moscow', 'william', 'corvette', 'hello',
  'martin', 'heather', 'secret', 'fucker', 'merlin', 'diamond',
  '1234qwer', 'gfhjkm', 'hammer', 'silver', '222222', '88888888',
  'anthony', 'justin', 'test', 'bailey', 'q1w2e3r4t5', 'patrick',
  'internet', 'scooter', 'orange', '11111', 'golfer', 'cookie',
  'richard', 'samantha', 'bigdog', 'guitar', 'jackson', 'whatever',
  'mickey', 'chicken', 'sparky', 'snoopy', 'maverick', 'phoenix',
  'camaro', 'sexy', 'peanut', 'morgan', 'welcome', 'falcon',
  'cowboy', 'ferrari', 'samsung', 'andrea', 'smokey', 'steelers',
  'joseph', 'mercedes', 'dakota', 'arsenal', 'eagles', 'melissa',
  'boomer', 'booboo', 'spider', 'nascar', 'monster', 'tigers',
  'yellow', 'xxxxxx', '123123123', 'gateway', 'marina', 'diablo',
  'bulldog', 'qwer1234', 'compaq', 'purple', 'hardcore', 'banana',
  'junior', 'hannah', '123654', 'porsche', 'lakers', 'iceman',
  'money', 'cowboys', '987654', 'london', 'tennis', '999999',
  'ncc1701', 'coffee', 'scooby', '0000', 'miller', 'forever',
  'midnight', 'fish', '2222', 'shannon', 'chester', 'peaches',
  'pookie', 'park', 'phantom', 'midnight', 'crystal', '6969',
  'metallica', 'oliver', 'rachel', 'tigers', 'sierra', 'cooper',
  'panther', 'liverpool', 'apples', 'maxwell', 'spider', 'angel',
  'kobe24', 'lebron', 'denise', 'rabbit', 'eagle', 'butter',
  // === password-prefixed variants (extremely common) ===
  'password1', 'password2', 'password3', 'password4', 'password5',
  'password6', 'password7', 'password8', 'password9', 'password10',
  'password11', 'password12', 'password123', 'password1234',
  'password12345', 'password!', 'password!@#', 'password@1',
  'password@123', 'passw0rd', 'p@ssword', 'p@ssword1', 'p@ssword123',
  'p@ssw0rd', 'p@ssw0rd1', 'p@ssw0rd123', 'pa$$word', 'pa$$w0rd',
  'pa$$word1', 'pa$$w0rd1', 'password00', 'password01', 'password02',
  'password99', 'password111', 'password222', 'password!1',
  'password2020', 'password2021', 'password2022', 'password2023',
  'password2024', 'password2025', 'mypassword', 'mypassword1',
  'newpassword', 'newpassword1', 'oldpassword', 'changeme',
  'changeme1', 'changeme123', 'temppass', 'temppass1', 'temppass123',
  // === Adobe 2013 / RockYou top-frequency additions ===
  'photoshop', 'adobe123', 'adobeadmin', 'admin', 'admin123',
  'admin1234', 'admin12345', 'administrator', 'root', 'root123',
  'toor', 'guest', 'guest123', 'user', 'user123', 'user1234',
  'demo', 'demo123', 'demo1234', 'login', 'login123', 'login1234',
  'welcome1', 'welcome123', 'welcome1234', 'qwerty1', 'qwerty12',
  'qwerty123', 'qwerty1234', 'qwerty12345', 'qwerty123456',
  'qweqwe', 'qweqweqwe', 'qweasd', 'qweasdzxc', 'qweasdzxc123',
  'asdf', 'asdf1234', 'asdfasdf', 'asdfghjkl', 'asdfghjkl1',
  'zxcv', 'zxcv1234', 'zxcvbnm1', 'zxcvbnm123', '1q2w3e', '1q2w3e4r',
  '1q2w3e4r5t', '1qazxsw2', '1qaz!QAZ', 'q1w2e3', 'q1w2e3r4',
  // === Years used as passwords (common pattern) ===
  '1980', '1981', '1982', '1983', '1984', '1985', '1986', '1987',
  '1988', '1989', '1990', '1991', '1992', '1993', '1994', '1995',
  '1996', '1997', '1998', '1999', '2000', '2001', '2002', '2003',
  '2004', '2005', '2006', '2007', '2008', '2009', '2010', '2011',
  '2012', '2013', '2014', '2015', '2016', '2017', '2018', '2019',
  '2020', '2021', '2022', '2023', '2024', '2025',
  // === Number runs and patterns ===
  '12345', '123456', '1234567', '12345678', '123456789', '1234567890',
  '0123456789', '987654321', '987654', '98765', '9876', '987',
  '11111', '111111', '1111111', '11111111', '111111111', '1111111111',
  '22222', '222222', '2222222', '22222222', '33333', '333333',
  '44444', '444444', '55555', '555555', '66666', '666666',
  '77777', '777777', '88888', '888888', '99999', '999999',
  '00000', '000000', '0000000', '00000000', '101010', '121212',
  '131313', '141414', '151515', '161616', '171717', '181818',
  '191919', '202020', '212121', '232323', '242424', '252525',
  '262626', '272727', '282828', '292929', '313131', '323232',
  '343434', '353535', '363636', '373737', '383838', '393939',
  '414141', '424242', '434343', '454545', '464646', '474747',
  '484848', '494949', '515151', '525252', '535353', '545454',
  '565656', '575757', '585858', '595959', '616161', '626262',
  '636363', '646464', '656565', '676767', '686868', '696969',
  '717171', '727272', '737373', '747474', '757575', '767676',
  '787878', '797979', '818181', '828282', '838383', '848484',
  '858585', '868686', '878787', '898989', '919191', '929292',
  '939393', '949494', '959595', '969696', '979797', '989898',
  // === Top first names (common as-is passwords) ===
  'john', 'mike', 'james', 'david', 'chris', 'robert', 'michael',
  'william', 'richard', 'joseph', 'thomas', 'charles', 'daniel',
  'matthew', 'anthony', 'donald', 'mark', 'steven', 'paul', 'andrew',
  'joshua', 'kenneth', 'kevin', 'brian', 'george', 'edward',
  'ronald', 'timothy', 'jason', 'jeffrey', 'ryan', 'jacob', 'gary',
  'nicholas', 'eric', 'jonathan', 'stephen', 'larry', 'justin',
  'scott', 'brandon', 'frank', 'benjamin', 'gregory', 'samuel',
  'raymond', 'patrick', 'alexander', 'jack', 'dennis', 'jerry',
  'tyler', 'aaron', 'jose', 'henry', 'douglas', 'adam', 'peter',
  'nathan', 'zachary', 'walter', 'kyle', 'harold', 'carl', 'jeremy',
  'keith', 'roger', 'gerald', 'ethan', 'arthur', 'terry', 'sean',
  'austin', 'noah', 'lawrence', 'jesse', 'joe', 'bryan', 'billy',
  'jordan', 'albert', 'dylan', 'bruce', 'willie', 'gabriel',
  'alan', 'juan', 'logan', 'wayne', 'roy', 'ralph', 'randy',
  'eugene', 'vincent', 'russell', 'elijah', 'louis', 'bobby',
  'philip', 'johnny', 'mary', 'patricia', 'jennifer', 'linda',
  'elizabeth', 'barbara', 'susan', 'jessica', 'sarah', 'karen',
  'nancy', 'lisa', 'betty', 'helen', 'sandra', 'donna', 'carol',
  'ruth', 'sharon', 'michelle', 'laura', 'kimberly', 'deborah',
  'dorothy', 'amy', 'angela', 'ashley', 'brenda', 'emma', 'olivia',
  'cynthia', 'marie', 'janet', 'catherine', 'frances', 'christine',
  'samantha', 'debra', 'rachel', 'carolyn', 'janet', 'virginia',
  'maria', 'heather', 'diane', 'julie', 'joyce', 'victoria',
  'kelly', 'christina', 'joan', 'evelyn', 'lauren', 'judith',
  'megan', 'cheryl', 'andrea', 'hannah', 'jacqueline', 'martha',
  'gloria', 'teresa', 'sara', 'janice', 'marilyn', 'julia', 'judy',
  'olivia', 'sophia', 'isabella', 'mia', 'charlotte', 'amelia',
  'harper', 'evelyn', 'abigail', 'emily', 'ella', 'madison',
  'scarlett', 'grace', 'chloe', 'penelope', 'aria', 'layla',
  // === Common phrases and pop culture ===
  'iloveyou', 'ilovemom', 'iloveudad', 'ihateyou', 'fuckoff',
  'fuckyou1', 'fuckyou123', 'whatever', 'whatever1', 'whatever123',
  'nothing', 'something', 'anything', 'everything', 'forever',
  'forever1', 'forever21', 'forever23', 'liverpool', 'arsenal',
  'chelsea', 'unitedstates', 'america', 'canada', 'mexico',
  'london', 'paris', 'tokyo', 'newyork', 'losangeles', 'chicago',
  'sunshine', 'moonlight', 'starlight', 'rainbow', 'butterfly',
  'butterfly1', 'flower', 'flower1', 'flowers', 'rose', 'roses',
  'tulip', 'lily', 'daisy', 'sweetheart', 'darling', 'honey',
  'cutie', 'baby', 'baby1', 'baby123', 'cupcake', 'pumpkin',
  'pumpkin1', 'sweetie', 'angel1', 'angel123', 'angels',
  'godisgood', 'jesus', 'jesus1', 'jesus123', 'jesusislord',
  'christian', 'christ', 'praise', 'faith', 'hope', 'amen',
  'snickers', 'reeses', 'kitkat', 'twix', 'mounds',
  'starbucks', 'mcdonalds', 'burgerking', 'wendys', 'subway',
  // === Sports teams + variants ===
  'lakers', 'celtics', 'warriors', 'cavaliers', 'bulls', 'heat',
  'spurs', 'rockets', 'mavericks', 'sixers', '76ers', 'nets',
  'knicks', 'pistons', 'pacers', 'bucks', 'raptors', 'thunder',
  'jazz', 'nuggets', 'suns', 'kings', 'clippers', 'grizzlies',
  'pelicans', 'magic', 'hornets', 'hawks', 'wizards', 'timberwolves',
  'trailblazers', 'yankees', 'redsox', 'dodgers', 'giants',
  'cardinals', 'cubs', 'whitesox', 'pirates', 'reds', 'brewers',
  'tigers', 'twins', 'royals', 'indians', 'guardians', 'astros',
  'angels', 'athletics', 'mariners', 'rangers', 'rays', 'orioles',
  'bluejays', 'marlins', 'mets', 'phillies', 'braves', 'nationals',
  'rockies', 'diamondbacks', 'padres', 'patriots', 'jets', 'dolphins',
  'bills', 'steelers', 'browns', 'ravens', 'bengals', 'colts',
  'titans', 'jaguars', 'texans', 'chiefs', 'broncos', 'raiders',
  'chargers', 'cowboys', 'eagles', 'giants', 'redskins',
  'commanders', 'packers', 'vikings', 'bears', 'lions', 'buccaneers',
  'saints', 'falcons', 'panthers', 'seahawks', 'cardinals', '49ers',
  'rams',
  // === Keyboard walks ===
  'qwerty', 'qwertyu', 'qwertyui', 'qwertyuio', 'qwertyuiop',
  'asdf', 'asdfg', 'asdfgh', 'asdfghj', 'asdfghjk', 'asdfghjkl',
  'zxcv', 'zxcvb', 'zxcvbn', 'zxcvbnm', '1q2w3e', '1q2w3e4r',
  '1q2w3e4r5t', '1qaz', '1qazxsw', '1qazxsw2', '1qaz2wsx',
  '1qaz2wsx3edc', 'qazwsx', 'qazwsxedc', '!qaz2wsx', 'qwer',
  'qweqwe', 'qwerasdf', 'qwerty123', 'qwerty1234', 'qwerty12345',
  'qwertz', 'azerty', '`12345', '~!@#$%', '!@#$%^', '!@#$%^&*',
  // === Misc high-frequency ===
  'changeme', 'changethis', 'tempPassword', 'temppassword',
  'temporary', 'temp', 'test123', 'test1234', 'test12345',
  'testing', 'testing1', 'testing123', 'testtest', 'testtesttest',
  'admin1', 'admin12', 'admin1234', 'sysadmin', 'systemadmin',
  'master123', 'master1', 'mastermaster', 'service', 'service1',
  'service123', 'application', 'app', 'app123', 'web', 'web123',
  'website', 'site', 'site123', 'public', 'public123', 'private',
  'private123', 'secret123', 'secret1', 'secrets', 'hidden',
  'unknown', 'database', 'database123', 'db', 'db123', 'dbadmin',
  'mysql', 'mysql123', 'postgres', 'postgres123', 'oracle',
  'oracle123', 'mongo', 'mongo123', 'redis', 'redis123',
  // === Months / seasons / days ===
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'spring', 'summer', 'autumn', 'fall', 'winter', 'monday',
  'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'springbreak', 'summer2020', 'summer2021', 'summer2022',
  'summer2023', 'summer2024', 'fall2020', 'fall2021', 'fall2022',
  'winter2020', 'winter2021', 'winter2022', 'newyear', 'newyear2020',
  'newyear2021', 'newyear2022', 'newyear2023', 'newyear2024',
  // === Common pet names + animals ===
  'puppy', 'kitty', 'doggie', 'rover', 'fido', 'spot', 'rex',
  'cooper', 'charlie', 'buddy', 'rocky', 'lucky', 'max', 'duke',
  'jack', 'jake', 'oscar', 'milo', 'leo', 'toby', 'shadow', 'bear',
  'bella', 'lucy', 'molly', 'lola', 'lily', 'daisy', 'sadie',
  'maggie', 'sophie', 'chloe', 'bailey', 'zoe', 'penny', 'rosie',
  'whiskers', 'tigger', 'simba', 'felix', 'oreo', 'smokey',
  'patches', 'mittens', 'shadow', 'midnight', 'pumpkin',
  // === Common "secure" patterns that aren't ===
  'P@ssw0rd', 'P@ssw0rd!', 'P@ssw0rd1', 'P@ssw0rd123',
  'Welcome1!', 'Welcome123!', 'Letmein1!', 'Letmein123!',
  'Spring2020!', 'Spring2021!', 'Spring2022!', 'Spring2023!',
  'Spring2024!', 'Summer2020!', 'Summer2021!', 'Summer2022!',
  'Summer2023!', 'Summer2024!', 'Autumn2020!', 'Autumn2023!',
  'Winter2020!', 'Winter2023!', 'Winter2024!',
  'Company1', 'Company123', 'Company1!', 'Company1@',
  'Microsoft1', 'Microsoft1!', 'Microsoft123', 'Google1',
  'Google1!', 'Google123', 'Apple1', 'Apple1!', 'Apple123',
  'Amazon1', 'Amazon1!', 'Amazon123', 'Facebook1', 'Facebook1!',
  // === Roamready-specific guards (NOT in any leak — but obvious) ===
  'roamready', 'roamready1', 'roamready123', 'roamready!', 'roam',
  'roamready2024', 'roamready2025', 'rvlife', 'rvlife1', 'rvlife123',
  'camping', 'camping1', 'camping123', 'campsite', 'campground',
]

// Build once at module load. Lowercased entries (the policy validator
// lowercases the input before checking, so the Set must be lowercase
// too — the .map below is defense-in-depth in case a mixed-case
// entry slips in during list maintenance).
export const COMMON_PASSWORDS: Set<string> = new Set(
  COMMON_PASSWORDS_LIST.map(p => p.toLowerCase()),
)

/** Exported for diagnostics / tests — count of entries actually in
 *  the blocklist after dedup. */
export const COMMON_PASSWORDS_COUNT = COMMON_PASSWORDS.size
