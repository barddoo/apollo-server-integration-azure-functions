import { ApolloServer } from '@apollo/server';
import { app } from '@azure/functions';
import { startServerAndCreateHandler } from '../../../';

// The GraphQL schema
const typeDefs = `#graphql
  type Query {
    hello: String
  }
`;

// A map of functions which return data for the schema.
const resolvers = {
  Query: {
    hello: () => 'world',
  },
};

// Set up Apollo Server
const server = new ApolloServer({
  typeDefs,
  resolvers,
});

app.http('graphql', {
  handler: startServerAndCreateHandler(server),
});
