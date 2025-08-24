import { createHmac } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { GraphQLClient, gql } from 'graphql-request';
import { Octokit } from '@octokit/rest';

const prisma = new PrismaClient();
const railway = new GraphQLClient('https://backboard.railway.app/graphql/v2', {
  headers: { Authorization: `Bearer ${process.env.RAILWAY_API_TOKEN}` },
});
const octokit = new Octokit({ auth: process.env.GITHUB_PAT });

async function triggerBuilderWorkflow(owner, repo, railwayServiceId, githubRepoId) {
  await octokit.rest.actions.createWorkflowDispatch({
    owner: 'VarunGupta2005', // <-- IMPORTANT: Your GitHub Username
    repo: 'Deployer',      // <-- IMPORTANT: The name of this repository
    workflow_id: 'builder.yml',
    ref: 'main',
    inputs: {
      owner,
      repo,
      railwayServiceId,
      githubRepoId: githubRepoId.toString(),
    },
  });
}

export default async function handler(req, res) {
  try {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    const signature = req.headers['x-hub-signature-256'];
    const payload = JSON.stringify(req.body);
    const hash = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    // Uncomment this block for production security
    // if (signature !== hash) {
    //   return res.status(401).json({ message: 'Invalid signature.' });
    // }

    const eventType = req.headers['x-github-event'];
    let repositoriesToProcess = [];

    if (eventType === 'push' && req.body.ref === 'refs/heads/main') {
      repositoriesToProcess.push(req.body.repository);
    } else if (eventType === 'installation_repositories' && req.body.action === 'added') {
      repositoriesToProcess = req.body.repositories_added;
    } else {
      return res.status(200).json({ message: 'Event ignored.' });
    }

    for (const repository of repositoriesToProcess) {
      const githubRepoId = BigInt(repository.id);
      const repoName = repository.full_name;
      const owner = repository.owner.login;
      const repo = repository.name;

      console.log(`Processing event for ${repoName}.`);
      let project = await prisma.project.findUnique({ where: { githubRepoId } });

      if (!project) {
        console.log(`First deployment for ${repoName}. Provisioning on Railway...`);

        const createProjectMutation = gql`mutation { projectCreate(input: { name: "${repoName}" }) { id } }`;
        const projectData = await railway.request(createProjectMutation);
        const railwayProjectId = projectData.projectCreate.id;

        const createServiceMutation = gql`
          mutation { serviceCreate(input: {
            name: "${repo}",
            projectId: "${railwayProjectId}",
            source: { image: "ghcr.io/railwayapp/nixpacks/node:latest" }
          }) { id } }
        `;
        const serviceData = await railway.request(createServiceMutation);
        const railwayServiceId = serviceData.serviceCreate.id;

        project = await prisma.project.create({
          data: { githubRepoId, repoName, railwayProjectId, railwayServiceId },
        });
        console.log(`Successfully provisioned Railway service ${railwayServiceId}.`);
      }

      console.log(`Triggering builder for service ${project.railwayServiceId}`);
      await triggerBuilderWorkflow(owner, repo, project.railwayServiceId, githubRepoId);
    }

    res.status(202).json({ message: 'Deployment process initiated.' });

  } catch (error) {
    console.error('Error in webhook handler:', error.message);
    res.status(500).json({ message: 'An internal error occurred.' });
  }
}