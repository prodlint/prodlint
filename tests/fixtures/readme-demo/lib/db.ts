// A stand-in for a database client. Kept free of any ORM package on purpose: a nested
// package.json's dependencies count for the whole scan, and this fixture shouldn't change how
// the repository scans itself.
type User = { email: string; role: string };

const users: User[] = [];

export const db = {
  user: {
    async create({ data }: { data: User }): Promise<User> {
      users.push(data);
      return data;
    },
  },
};
