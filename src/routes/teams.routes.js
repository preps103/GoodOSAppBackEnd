const express = require("express");

const authRequired =
  require("../middleware/authRequired");

const {
  success,
  error,
} = require("../utils/response");

const teamsService =
  require("../services/teams.service");

const router = express.Router();

function requestError(
  res,
  routeName,
  err
) {
  console.error(
    `Teams ${routeName} failed:`,
    err
  );

  return error(
    res,
    err.message ||
      `Failed to load Teams ${routeName}.`,
    err.statusCode || 500
  );
}

router.get(
  "/health",
  async (req, res) => {
    try {
      const health =
        await teamsService
          .getSchemaHealth();

      return success(res, {
        service: "GoodOS Teams",

        status:
          health.schemaReady
            ? "ok"
            : "degraded",

        schemaReady:
          health.schemaReady,
      });
    } catch (err) {
      return requestError(
        res,
        "health",
        err
      );
    }
  }
);

router.use(authRequired);

router.get(
  "/summary",
  async (req, res) => {
    try {
      const summary =
        await teamsService
          .getSummaryForUser(
            req.user.id
          );

      return success(res, {
        summary,
      });
    } catch (err) {
      return requestError(
        res,
        "summary",
        err
      );
    }
  }
);

router.get(
  "/members",
  async (req, res) => {
    try {
      const result =
        await teamsService
          .getMembersForUser(
            req.user.id,
            {
              page:
                req.query.page,

              pageSize:
                req.query.pageSize,

              search:
                req.query.search,

              teamId:
                req.query.teamId,

              role:
                req.query.role,
            }
          );

      return success(
        res,
        result
      );
    } catch (err) {
      return requestError(
        res,
        "members",
        err
      );
    }
  }
);

router.get(
  "/roles",
  async (req, res) => {
    try {
      const result =
        await teamsService
          .getRolesForUser(
            req.user.id
          );

      return success(
        res,
        result
      );
    } catch (err) {
      return requestError(
        res,
        "roles",
        err
      );
    }
  }
);

router.get(
  "/groups",
  async (req, res) => {
    try {
      const result =
        await teamsService
          .getTeamsForUser(
            req.user.id
          );

      return success(
        res,
        result
      );
    } catch (err) {
      return requestError(
        res,
        "groups",
        err
      );
    }
  }
);

router.get(
  "/invitations",
  async (req, res) => {
    try {
      const result =
        await teamsService
          .getInvitationsForUser(
            req.user.id
          );

      return success(
        res,
        result
      );
    } catch (err) {
      return requestError(
        res,
        "invitations",
        err
      );
    }
  }
);

router.get(
  "/activity",
  async (req, res) => {
    try {
      const result =
        await teamsService
          .getActivityForUser(
            req.user.id,
            {
              limit:
                req.query.limit,
            }
          );

      return success(
        res,
        result
      );
    } catch (err) {
      return requestError(
        res,
        "activity",
        err
      );
    }
  }
);


// GOODOS_TEAMS_PRODUCTION_ROUTES_V1

router.get(
  "/permissions",
  async (req, res) => {
    try {
      const result =
        await teamsService
          .getTeamPermissionsForUser(
            req.user.id
          );

      return success(res, result);
    } catch (err) {
      return requestError(
        res,
        "permissions",
        err
      );
    }
  }
);

router.post(
  "/groups",
  async (req, res) => {
    try {
      const team =
        await teamsService
          .createTeamForUser(
            req.user.id,
            req.body || {},
            {
              ipAddress: req.ip,
            }
          );

      return success(
        res,
        {
          message:
            "Team created successfully.",
          team,
        },
        201
      );
    } catch (err) {
      return requestError(
        res,
        "team creation",
        err
      );
    }
  }
);

router.patch(
  "/groups/:teamId",
  async (req, res) => {
    try {
      const team =
        await teamsService
          .updateTeamForUser(
            req.user.id,
            req.params.teamId,
            req.body || {},
            {
              ipAddress: req.ip,
            }
          );

      return success(res, {
        message:
          "Team updated successfully.",
        team,
      });
    } catch (err) {
      return requestError(
        res,
        "team update",
        err
      );
    }
  }
);

router.delete(
  "/groups/:teamId",
  async (req, res) => {
    try {
      const team =
        await teamsService
          .updateTeamForUser(
            req.user.id,
            req.params.teamId,
            {
              status: "archived",
            },
            {
              ipAddress: req.ip,
            }
          );

      return success(res, {
        message:
          "Team archived successfully.",
        team,
      });
    } catch (err) {
      return requestError(
        res,
        "team archive",
        err
      );
    }
  }
);

router.patch(
  "/members/:userId",
  async (req, res) => {
    try {
      const member =
        await teamsService
          .updateTeamMemberForUser(
            req.user.id,
            req.params.userId,
            req.body || {},
            {
              ipAddress: req.ip,
            }
          );

      return success(res, {
        message:
          "Member updated successfully.",
        member,
      });
    } catch (err) {
      return requestError(
        res,
        "member update",
        err
      );
    }
  }
);

router.post(
  "/invitations",
  async (req, res) => {
    try {
      const result =
        await teamsService
          .inviteTeamMemberForUser(
            req.user.id,
            req.body || {},
            {
              ipAddress: req.ip,
            }
          );

      return success(
        res,
        result,
        result.memberAdded
          ? 200
          : 201
      );
    } catch (err) {
      return requestError(
        res,
        "invitation creation",
        err
      );
    }
  }
);

router.post(
  "/invitations/accept",
  async (req, res) => {
    try {
      const result =
        await teamsService
          .acceptTeamInvitationForUser(
            req.user.id,
            req.body?.token,
            {
              ipAddress: req.ip,
            }
          );

      return success(res, result);
    } catch (err) {
      return requestError(
        res,
        "invitation acceptance",
        err
      );
    }
  }
);

router.post(
  "/invitations/:invitationId/resend",
  async (req, res) => {
    try {
      const invitation =
        await teamsService
          .resendTeamInvitationForUser(
            req.user.id,
            req.params.invitationId,
            {
              ipAddress: req.ip,
            }
          );

      return success(res, {
        message:
          "Invitation renewed successfully.",
        invitation,
      });
    } catch (err) {
      return requestError(
        res,
        "invitation resend",
        err
      );
    }
  }
);

router.delete(
  "/invitations/:invitationId",
  async (req, res) => {
    try {
      const invitation =
        await teamsService
          .revokeTeamInvitationForUser(
            req.user.id,
            req.params.invitationId,
            {
              ipAddress: req.ip,
            }
          );

      return success(res, {
        message:
          "Invitation revoked successfully.",
        invitation,
      });
    } catch (err) {
      return requestError(
        res,
        "invitation revocation",
        err
      );
    }
  }
);

router.post(
  "/roles",
  async (req, res) => {
    try {
      const role =
        await teamsService
          .createTeamRoleForUser(
            req.user.id,
            req.body || {},
            {
              ipAddress: req.ip,
            }
          );

      return success(
        res,
        {
          message:
            "Custom role created successfully.",
          role,
        },
        201
      );
    } catch (err) {
      return requestError(
        res,
        "role creation",
        err
      );
    }
  }
);

router.patch(
  "/roles/:roleId",
  async (req, res) => {
    try {
      const role =
        await teamsService
          .updateTeamRoleForUser(
            req.user.id,
            req.params.roleId,
            req.body || {},
            {
              ipAddress: req.ip,
            }
          );

      return success(res, {
        message:
          "Custom role updated successfully.",
        role,
      });
    } catch (err) {
      return requestError(
        res,
        "role update",
        err
      );
    }
  }
);

router.delete(
  "/roles/:roleId",
  async (req, res) => {
    try {
      const role =
        await teamsService
          .archiveTeamRoleForUser(
            req.user.id,
            req.params.roleId,
            {
              ipAddress: req.ip,
            }
          );

      return success(res, {
        message:
          "Custom role archived successfully.",
        role,
      });
    } catch (err) {
      return requestError(
        res,
        "role archive",
        err
      );
    }
  }
);



// GOODOS_TEAM_WORKSPACE_ROUTES_V2

router.get(
  "/groups/:teamId",
  async (req, res) => {
    try {
      const result =
        await teamsService
          .getTeamDetailsForUser(
            req.user.id,
            req.params.teamId
          );

      return success(res, result);
    } catch (err) {
      return requestError(
        res,
        "team details",
        err
      );
    }
  }
);

router.put(
  "/groups/:teamId/members/:userId",
  async (req, res) => {
    try {
      const membership =
        await teamsService
          .upsertTeamMembershipForUser(
            req.user.id,
            req.params.teamId,
            req.params.userId,
            req.body || {},
            {
              ipAddress: req.ip,
            }
          );

      return success(res, {
        message:
          "Team membership saved successfully.",
        membership,
      });
    } catch (err) {
      return requestError(
        res,
        "team membership update",
        err
      );
    }
  }
);

router.delete(
  "/groups/:teamId/members/:userId",
  async (req, res) => {
    try {
      const membership =
        await teamsService
          .removeTeamMembershipForUser(
            req.user.id,
            req.params.teamId,
            req.params.userId,
            {
              ipAddress: req.ip,
            }
          );

      return success(res, {
        message:
          "Member removed from the team.",
        membership,
      });
    } catch (err) {
      return requestError(
        res,
        "team membership removal",
        err
      );
    }
  }
);

router.post(
  "/members/bulk-team",
  async (req, res) => {
    try {
      const result =
        await teamsService
          .bulkTeamMembershipForUser(
            req.user.id,
            req.body || {},
            {
              ipAddress: req.ip,
            }
          );

      return success(res, {
        message:
          result.action === "assign"
            ? `${result.updatedMembers} members assigned to ${result.teamName}.`
            : `${result.updatedMembers} members removed from ${result.teamName}.`,
        result,
      });
    } catch (err) {
      return requestError(
        res,
        "bulk team membership",
        err
      );
    }
  }
);


module.exports = router;
