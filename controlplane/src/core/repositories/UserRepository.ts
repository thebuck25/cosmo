import { eq } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../../db/schema.js';
import { users } from '../../db/schema.js';
import { UserDTO } from '../../types/index.js';
import Keycloak from '../services/Keycloak.js';

/**
 * Repository for user related operations.
 */
export class UserRepository {
  constructor(private db: PostgresJsDatabase<typeof schema>) {}

  public async byEmail(email: string): Promise<UserDTO | null> {
    const user = await this.db
      .select({
        email: users.email,
        id: users.id,
      })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1)
      .execute();

    if (user.length === 0) {
      return null;
    }

    return user[0];
  }

  public async byId(id: string): Promise<UserDTO | null> {
    const user = await this.db
      .select({
        email: users.email,
        id: users.id,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
      .execute();

    if (user.length === 0) {
      return null;
    }

    return user[0];
  }

  public async addUser(input: { id: string; email: string }) {
    await this.db
      .insert(users)
      .values({
        id: input.id,
        email: input.email.toLowerCase(),
      })
      .execute();
  }

  public deleteUser(input: { id: string; keycloakClient: Keycloak; keycloakRealm: string }) {
    return this.db.transaction(async (tx) => {
      // Delete from db
      await tx.delete(users).where(eq(users.id, input.id)).execute();

      // Delete from keycloak
      await input.keycloakClient.authenticateClient();
      await input.keycloakClient.client.users.del({
        id: input.id,
        realm: input.keycloakRealm,
      });
    });
  }

  // only to update the active attribute
  public async updateUser(input: { id: string; active: boolean }) {
    await this.db
      .update(users)
      .set({ active: input.active, updatedAt: new Date() })
      .where(eq(users.id, input.id))
      .execute();
  }
}
